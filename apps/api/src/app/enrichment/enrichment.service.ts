import { FetchService } from '@ghostfolio/api/services/fetch/fetch.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { AdminEnrichmentResponse } from '@ghostfolio/common/interfaces';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from '@prisma/client';
import ms from 'ms';

@Injectable()
export class EnrichmentService {
  private readonly logger = new Logger(EnrichmentService.name);

  private static readonly REQUEST_TIMEOUT = ms('30 seconds');
  private static readonly SHEET_CSV_URL =
    'https://docs.google.com/spreadsheets/d/1IUYBr3YyYzjrBuN3E3YsuSWLJ3ps5RNTsLsvdrXtLt4/export?format=csv&gid=0';

  public constructor(
    private readonly fetchService: FetchService,
    private readonly prismaService: PrismaService
  ) {}

  public async enrichFromSheet(): Promise<AdminEnrichmentResponse> {
    let csv: string;

    try {
      const response = await this.fetchService.fetch(
        EnrichmentService.SHEET_CSV_URL,
        { signal: AbortSignal.timeout(EnrichmentService.REQUEST_TIMEOUT) }
      );

      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }

      csv = await response.text();
    } catch (error) {
      throw new BadRequestException(
        `Could not fetch the Google Sheet: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const rows = this.parseSheetCsv(csv);
    const updatedSymbols: string[] = [];
    let updatedProfilesCount = 0;

    for (const { isin, sector, site, ticker } of rows) {
      const data: {
        countries?: { code: string; weight: number }[];
        sectors?: { name: string; weight: number }[];
        url?: string;
      } = {
        countries: [{ code: 'RU', weight: 1 }]
      };

      if (site) {
        data.url = site;
      }

      if (sector) {
        data.sectors = [{ name: sector, weight: 1 }];
      }

      // Prefer the ISIN match (exact instrument), fall back to the ticker
      let { count } = { count: 0 };

      if (isin) {
        ({ count } = await this.prismaService.symbolProfile.updateMany({
          data,
          where: { dataSource: DataSource.MOSCOW_EXCHANGE, isin }
        }));
      }

      if (count === 0 && ticker) {
        ({ count } = await this.prismaService.symbolProfile.updateMany({
          data,
          where: {
            dataSource: DataSource.MOSCOW_EXCHANGE,
            symbol: `${ticker}.MOEX`
          }
        }));
      }

      if (count > 0) {
        updatedProfilesCount += count;
        updatedSymbols.push(ticker || isin);
      }
    }

    this.logger.log(
      `Enriched ${updatedProfilesCount} asset profiles from ${rows.length} sheet rows`
    );

    return {
      matchedRowsCount: updatedSymbols.length,
      totalRowsCount: rows.length,
      updatedProfilesCount,
      updatedSymbols
    };
  }

  private parseSheetCsv(csv: string): {
    isin: string;
    sector: string;
    site: string;
    ticker: string;
  }[] {
    const lines = csv
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');

    if (lines.length < 2) {
      return [];
    }

    const headers = this.parseCsvLine(lines[0]).map((header) => {
      return header.trim().toLowerCase();
    });

    const indexOf = (names: string[]): number => {
      return headers.findIndex((header) => names.includes(header));
    };

    const isinIndex = indexOf(['isin']);
    const sectorIndex = indexOf(['сектор', 'sector']);
    const siteIndex = indexOf(['официальный сайт', 'сайт', 'site', 'url']);
    const tickerIndex = indexOf(['тикер', 'ticker']);

    const rows: {
      isin: string;
      sector: string;
      site: string;
      ticker: string;
    }[] = [];

    for (const line of lines.slice(1)) {
      const cells = this.parseCsvLine(line);
      const cellAt = (index: number): string => {
        return index >= 0 ? (cells[index] ?? '').trim() : '';
      };

      const row = {
        isin: cellAt(isinIndex),
        sector: cellAt(sectorIndex),
        site: cellAt(siteIndex),
        ticker: cellAt(tickerIndex).toUpperCase()
      };

      if (!row.isin && !row.ticker) {
        continue;
      }

      rows.push(row);
    }

    return rows;
  }

  private parseCsvLine(line: string): string[] {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const character = line[i];

      if (inQuotes) {
        if (character === '"') {
          if (line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += character;
        }
      } else if (character === '"') {
        inQuotes = true;
      } else if (character === ',') {
        cells.push(current);
        current = '';
      } else {
        current += character;
      }
    }

    cells.push(current);

    return cells;
  }
}
