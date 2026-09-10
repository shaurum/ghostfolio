import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import {
  DataProviderInterface,
  GetAssetProfileParams,
  GetDividendsParams,
  GetHistoricalParams,
  GetQuotesParams,
  GetSearchParams
} from '@ghostfolio/api/services/data-provider/interfaces/data-provider.interface';
import { FetchService } from '@ghostfolio/api/services/fetch/fetch.service';
import { DATE_FORMAT } from '@ghostfolio/common/helper';
import {
  DataProviderHistoricalResponse,
  DataProviderInfo,
  DataProviderResponse,
  LookupItem,
  LookupResponse
} from '@ghostfolio/common/interfaces';
import { MarketState } from '@ghostfolio/common/types';

import { Injectable, Logger } from '@nestjs/common';
import {
  AssetClass,
  AssetSubClass,
  DataSource,
  SymbolProfile
} from '@prisma/client';
import { format, addDays } from 'date-fns';
import { isNumber } from 'lodash';

@Injectable()
export class MoscowExchangeService implements DataProviderInterface {
  private readonly logger = new Logger(MoscowExchangeService.name);

  private readonly BOARDS_PRIORITY = [
    'TQBR',
    'TQTF',
    'TQIF',
    'TQCB',
    'TQOB',
    'TQDB'
  ];
  private readonly CURRENCY = 'RUB';
  private readonly SYMBOL_SUFFIX = '.MOEX';
  private readonly URL = 'https://iss.moex.com/iss';

  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly fetchService: FetchService
  ) {}

  private async delay(ms: number) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private async fetchJson(
    url: string,
    { requestTimeout, retries = 1 }: { requestTimeout: number; retries?: number }
  ) {
    let lastError: Error;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.fetchService
          .fetch(url, { signal: AbortSignal.timeout(requestTimeout) })
          .then((res) => res.json());
      } catch (error) {
        lastError = error;

        if (error?.name === 'AbortError') {
          throw error;
        }

        if (attempt < retries) {
          await this.delay(250 * (attempt + 1));
        }
      }
    }

    throw lastError;
  }

  public canHandle(aSymbol: string) {
    return aSymbol.toUpperCase().endsWith(this.SYMBOL_SUFFIX);
  }

  public async getAssetProfile({
    requestTimeout = this.configurationService.get('REQUEST_TIMEOUT'),
    symbol
  }: GetAssetProfileParams): Promise<Partial<SymbolProfile>> {
    const secid = this.toExchangeSymbol(symbol);

    try {
      const [description, boards] = await Promise.all([
        this.getDescription({ requestTimeout, secid }),
        this.getBoards({ requestTimeout, secid })
      ]).catch(() => {
        return [undefined, undefined];
      });

      if (!description || !boards?.length) {
        return undefined;
      }

      const primaryBoard = boards.find(({ is_primary }) => {
        return is_primary === '1';
      });

      const { assetClass, assetSubClass } = this.parseAssetClass(
        description['GROUP']
      );
      const currency =
        primaryBoard?.currencyid
          ? this.convertCurrency(primaryBoard.currencyid)
          : this.CURRENCY;

      return {
        symbol,
        assetClass,
        assetSubClass,
        currency,
        dataSource: this.getName(),
        isin: description['ISIN'],
        name: description['NAME'] ?? description['SHORTNAME']
      };
    } catch (error) {
      this.logger.error(
        `Could not get asset profile for ${symbol} (${this.getName()}): [${error.name}] ${error.message}`
      );
    }

    return undefined;
  }

  public getDataProviderInfo(): DataProviderInfo {
    return {
      dataSource: DataSource.MOSCOW_EXCHANGE,
      isPremium: false,
      name: 'Moscow Exchange',
      url: 'https://www.moex.com/'
    };
  }

  public async getDividends({}: GetDividendsParams) {
    return {};
  }

  public async getHistorical({
    from,
    granularity = 'day',
    requestTimeout = this.configurationService.get('REQUEST_TIMEOUT'),
    symbol,
    to
  }: GetHistoricalParams): Promise<{
    [date: string]: DataProviderHistoricalResponse;
  }> {
    const secid = this.toExchangeSymbol(symbol);

    try {
      const description = await this.getDescription({ requestTimeout, secid })
        .catch(() => {
          return undefined;
        });

      const group = String(description?.['GROUP'] ?? '').toLowerCase();
      const isBond = group === 'stock_bonds' || group === 'stock_eurobond';
      const faceValue = isBond ? Number(description?.['FACEVALUE']) : undefined;

      let market: string;

      switch (group) {
        case 'stock_bonds':
        case 'stock_eurobond':
          market = 'bonds';
          break;
        case 'stock_etf':
          market = 'etf';
          break;
        case 'stock_ppif':
          market = 'ppif';
          break;
        case 'stock_shares':
          market = 'shares';
          break;
        default:
          return {};
      }

      const fromDateString = format(from, DATE_FORMAT);
      const toDateString = format(to, DATE_FORMAT);

      const queryParams = new URLSearchParams({
        'candles.columns': 'begin,close',
        from: fromDateString,
        interval: granularity === 'month' ? '31' : '24',
        till:
          fromDateString === toDateString
            ? format(addDays(to, 1), DATE_FORMAT)
            : toDateString,
        'iss.meta': 'off'
      });

      const { candles } = await this.fetchJson(
        `${this.URL}/engines/stock/markets/${market}/securities/${secid}/candles.json?${queryParams}`,
        { requestTimeout }
      );

      const result: {
        [date: string]: DataProviderHistoricalResponse;
      } = {};

      for (const { begin, close } of this.getRows<{
        begin: string;
        close: number;
      }>(candles)) {
        result[begin?.slice(0, 10)] = {
          marketPrice:
            isBond && isNumber(faceValue) ? (close * faceValue) / 100 : close
        };
      }

      return result;
    } catch (error) {
      throw new Error(
        `Could not get historical market data for ${symbol} (${this.getName()}) from ${format(
          from,
          DATE_FORMAT
        )} to ${format(to, DATE_FORMAT)}: [${error.name}] ${error.message}`
      );
    }
  }

  public getMaxNumberOfSymbolsPerRequest() {
    // It is not recommended requesting many securities per request
    return 10;
  }

  public getName(): DataSource {
    return DataSource.MOSCOW_EXCHANGE;
  }

  public async getQuotes({
    requestTimeout = this.configurationService.get('REQUEST_TIMEOUT'),
    symbols
  }: GetQuotesParams): Promise<{ [symbol: string]: DataProviderResponse }> {
    const response: { [symbol: string]: DataProviderResponse } = {};

    if (symbols.length <= 0) {
      return response;
    }

    const exchangeSymbols = Array.from(
      new Set(
        symbols.map((symbol) => {
          return this.toExchangeSymbol(symbol);
        })
      )
    );

    try {
      for (const market of ['shares', 'bonds']) {
        try {
          const quotes = await this.getQuotesOfMarket({
            market,
            requestTimeout,
            symbols: exchangeSymbols
          });

          for (const [secid, quote] of Object.entries(quotes)) {
            response[`${secid}${this.SYMBOL_SUFFIX}`] = {
              ...quote,
              currency: this.CURRENCY,
              dataProviderInfo: this.getDataProviderInfo(),
              dataSource: this.getName()
            };
          }
        } catch (error) {
          this.logger.error(
            `Could not get quotes for market ${market} (${this.getName()}): [${error.name}] ${error.message}`
          );
        }
      }
    } catch (error) {
      let message = error;

      if (['AbortError', 'TimeoutError'].includes(error?.name)) {
        message = `RequestError: The operation to get the quotes for ${symbols.join(
          ', '
        )} was aborted because the request to the data provider took more than ${(
          this.configurationService.get('REQUEST_TIMEOUT') / 1000
        ).toFixed(3)} seconds`;
      }

      this.logger.error(message);
    }

    return response;
  }

  public getTestSymbol() {
    return `SBER${this.SYMBOL_SUFFIX}`;
  }

  public async search({
    query,
    requestTimeout = this.configurationService.get('REQUEST_TIMEOUT')
  }: GetSearchParams): Promise<LookupResponse> {
    let items: LookupItem[] = [];

    try {
      const queryParams = new URLSearchParams({
        'iss.limit': '200',
        'iss.meta': 'off',
        'iss.only': 'securities',
        q: query,
        'securities.columns':
          'secid,shortname,name,isin,type,group,primary_boardid,is_traded'
      });

      const { securities } = await this.fetchJson(
        `${this.URL}/securities.json?${queryParams}`,
        { requestTimeout }
      );

      const rows = this.getRows<{
        group: string;
        is_traded: number;
        isin: string;
        name: string;
        secid: string;
        shortname: string;
      }>(securities);

      items = rows
        .filter(({ group, is_traded }) => {
          const { assetClass } = this.parseAssetClass(group);

          return assetClass && Number(is_traded) === 1;
        })
        .map(({ group, name, secid, shortname }) => {
          const { assetClass, assetSubClass } = this.parseAssetClass(group);

          return {
            assetClass,
            assetSubClass,
            currency: this.CURRENCY,
            dataProviderInfo: this.getDataProviderInfo(),
            dataSource: this.getName(),
            name: shortname ?? name,
            symbol: `${secid}${this.SYMBOL_SUFFIX}`
          };
        });
    } catch (error) {
      let message = error;

      if (['AbortError', 'TimeoutError'].includes(error?.name)) {
        message = `RequestError: The operation to search for ${query} was aborted because the request to the data provider took more than ${(
          this.configurationService.get('REQUEST_TIMEOUT') / 1000
        ).toFixed(3)} seconds`;
      }

      this.logger.error(message);
    }

    return { items };
  }

  private convertCurrency(aCurrencyId: string) {
    return aCurrencyId === 'SUR' ? this.CURRENCY : aCurrencyId;
  }

  private async getBoards({
    requestTimeout,
    secid
  }: {
    requestTimeout: number;
    secid: string;
  }) {
    const queryParams = new URLSearchParams({
      'iss.meta': 'off',
      'iss.only': 'boards'
    });

    const { boards } = await this.fetchJson(
      `${this.URL}/securities/${secid}.json?${queryParams}`,
      { requestTimeout }
    );

    return this.getRows(boards) as {
      boardid: string;
      currencyid: string;
      is_primary: string;
      unit: string;
    }[];
  }

  private async getDescription({
    requestTimeout,
    secid
  }: {
    requestTimeout: number;
    secid: string;
  }): Promise<{ [name: string]: string }> {
    const queryParams = new URLSearchParams({
      'description.columns': 'name,value',
      'iss.meta': 'off',
      'iss.only': 'description'
    });

    const { description } = await this.fetchJson(
      `${this.URL}/securities/${secid}.json?${queryParams}`,
      { requestTimeout }
    );

    return this.getRows<{ name: string; value: string }>(description).reduce(
      (result, { name, value }) => {
        result[name] = value;

        return result;
      },
      {}
    );
  }

  private getQuotesOfMarket({
    market,
    requestTimeout,
    symbols
  }: {
    market: string;
    requestTimeout: number;
    symbols: string[];
  }): Promise<{
    [secid: string]: {
      marketPrice: number;
      marketState: MarketState;
    };
  }> {
    const queryParams = new URLSearchParams({
      'iss.meta': 'off',
      'iss.only': 'securities,marketdata',
      'marketdata.columns':
        'SECID,BOARDID,LAST,MARKETPRICE,WAPRICE,TRADINGSTATUS,TRADINGSESSION,VOLTODAY',
      securities: symbols.join(','),
      'securities.columns':
        'SECID,BOARDID,SHORTNAME,SECNAME,FACEVALUE,CURRENCYID,STATUS'
    });

    return this.fetchJson(
      `${this.URL}/engines/stock/markets/${market}/securities.json?${queryParams}`,
      { requestTimeout }
    ).then(({ marketdata, securities }) => {
        const marketDataRows = this.getRows(marketdata).filter(
          ({ SECID }) => {
            return symbols.includes(SECID as string);
          }
        ) as {
          BOARDID: string;
          LAST: number;
          MARKETPRICE: number;
          SECID: string;
          TRADINGSTATUS: string;
          WAPRICE: number;
        }[];
        const securitiesRows = this.getRows(securities) as {
          SECID: string;
          BOARDID: string;
          FACEVALUE: string;
        }[];

        const isBondMarket = market === 'bonds';
        const faceValues: { [secid: string]: number } = {};

        for (const { FACEVALUE, SECID } of securitiesRows) {
          if (!(SECID in faceValues) && isNumber(Number(FACEVALUE))) {
            faceValues[SECID] = Number(FACEVALUE);
          }
        }

        const quotes: {
          [secid: string]: {
            marketPrice: number;
            marketState: MarketState;
          };
        } = {};
        const selectedSecIds: string[] = [];

        // Select the best quote per security by the board priority
        for (const boardId of [...this.BOARDS_PRIORITY, '']) {
          for (const row of marketDataRows) {
            const { BOARDID, LAST, MARKETPRICE, SECID, TRADINGSTATUS, WAPRICE } =
              row;

            if (BOARDID !== boardId || selectedSecIds.includes(SECID)) {
              continue;
            }

            const rawPrice = isNumber(LAST)
              ? LAST
              : isNumber(MARKETPRICE)
                ? MARKETPRICE
                : WAPRICE;

            if (!isNumber(rawPrice)) {
              continue;
            }

            const marketPrice = isBondMarket
              ? (rawPrice * faceValues[SECID]) / 100
              : rawPrice;
            const marketState: MarketState =
              TRADINGSTATUS === 'T' ? 'open' : 'closed';

            quotes[SECID] = { marketPrice, marketState };
            selectedSecIds.push(SECID);
          }
        }

        return quotes;
      });
  }

  private getRows<T extends Record<string, string | number>>(aBlockData: {
    columns: string[];
    data: (string | number)[][];
  }): T[] {
    return (
      aBlockData?.data?.map((row) => {
        return Object.fromEntries(
          aBlockData.columns.map((column, index) => {
            return [column, row[index]];
          })
        );
      }) ?? []
    ) as T[];
  }

  private parseAssetClass(aGroup: string): {
    assetClass: AssetClass;
    assetSubClass: AssetSubClass;
  } {
    let assetClass: AssetClass;
    let assetSubClass: AssetSubClass;

    switch (aGroup?.toLowerCase()) {
      case 'stock_ppif':
        assetClass = AssetClass.EQUITY;
        assetSubClass = AssetSubClass.MUTUALFUND;
        break;
      case 'stock_etf':
        assetClass = AssetClass.EQUITY;
        assetSubClass = AssetSubClass.ETF;
        break;
      case 'stock_bonds':
      case 'stock_eurobond':
        assetClass = AssetClass.FIXED_INCOME;
        assetSubClass = AssetSubClass.BOND;
        break;
      case 'stock_dr':
      case 'stock_foreign_shares':
      case 'stock_shares':
        assetClass = AssetClass.EQUITY;
        assetSubClass = AssetSubClass.STOCK;
        break;
    }

    return { assetClass, assetSubClass };
  }

  private toExchangeSymbol(aSymbol: string) {
    return aSymbol.toUpperCase().replace(this.SYMBOL_SUFFIX, '');
  }
}