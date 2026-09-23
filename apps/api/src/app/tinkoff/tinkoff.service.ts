import { ImportService } from '@ghostfolio/api/app/import/import.service';
import { DataProviderService } from '@ghostfolio/api/services/data-provider/data-provider.service';
import { FetchService } from '@ghostfolio/api/services/fetch/fetch.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { PropertyService } from '@ghostfolio/api/services/property/property.service';
import { PROPERTY_TINKOFF_API_TOKEN } from '@ghostfolio/common/config';
import {
  CreateAccountWithBalancesDto,
  CreateOrderDto
} from '@ghostfolio/common/dtos';
import { getAssetProfileIdentifier } from '@ghostfolio/common/helper';
import { AdminTinkoffSyncResponse } from '@ghostfolio/common/interfaces';
import { UserWithSettings } from '@ghostfolio/common/types';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource, Type } from '@prisma/client';
import { Big } from 'big.js';
import ms from 'ms';

import {
  TinkoffAccount,
  TinkoffGetAccountsResponse,
  TinkoffGetOperationsByCursorResponse,
  TinkoffInstrument,
  TinkoffInstrumentRequest,
  TinkoffInstrumentResponse,
  TinkoffMoneyValue,
  TinkoffOperation
} from './interfaces/tinkoff.invest.interface';

@Injectable()
export class TinkoffService {
  private readonly logger = new Logger(TinkoffService.name);

  private static readonly BASE_URL =
    'https://invest-public-api.tinkoff.ru/rest';
  private static readonly GET_ACCOUNTS_PATH =
    'tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts';
  private static readonly GET_INSTRUMENT_BY_PATH =
    'tinkoff.public.invest.api.contract.v1.InstrumentsService/GetInstrumentBy';
  private static readonly GET_OPERATIONS_BY_CURSOR_PATH =
    'tinkoff.public.invest.api.contract.v1.OperationsService/GetOperationsByCursor';
  private static readonly INSTRUMENT_ID_TYPE_FIGI = 'INSTRUMENT_ID_TYPE_FIGI';
  private static readonly INSTRUMENT_ID_TYPE_POSITION_UID =
    'INSTRUMENT_ID_TYPE_POSITION_UID';
  private static readonly INSTRUMENT_ID_TYPE_UID = 'INSTRUMENT_ID_TYPE_UID';
  private static readonly MANUAL_ACTIVITY_PREFIX = 'tinkoff_';
  private static readonly OPERATIONS_FROM = '2000-01-01T00:00:00Z';
  private static readonly PLATFORM_ID = 'tinkoff';
  private static readonly REQUEST_TIMEOUT = ms('30 seconds');
  private static readonly SUPPORTED_CLASS_CODES = [
    'PSAU',
    'TQBR',
    'TQTF',
    'TQIF',
    'TQCB',
    'TQOB',
    'TQDB'
  ];

  private readonly instrumentsCache = new Map<string, TinkoffInstrument>();

  public constructor(
    private readonly dataProviderService: DataProviderService,
    private readonly fetchService: FetchService,
    private readonly importService: ImportService,
    private readonly prismaService: PrismaService,
    private readonly propertyService: PropertyService
  ) {}

  public async sync({
    isDryRun,
    user
  }: {
    isDryRun: boolean;
    user: UserWithSettings;
  }): Promise<AdminTinkoffSyncResponse> {
    const token = (
      await this.propertyService.getByKey<string>(PROPERTY_TINKOFF_API_TOKEN)
    )?.trim();

    if (!token) {
      throw new BadRequestException(
        'The Tinkoff API token is not configured in the admin settings'
      );
    }

    const accounts = await this.getAccounts(token);

    if (accounts.length === 0) {
      throw new BadRequestException(
        'No Tinkoff accounts have been found for the API token'
      );
    }

    try {
      const probe = await this.post<TinkoffInstrumentResponse>({
        body: {
          id: 'BBG004730N88',
          idType: TinkoffService.INSTRUMENT_ID_TYPE_FIGI,
          classCode: 'TQBR'
        },
        path: TinkoffService.GET_INSTRUMENT_BY_PATH,
        token
      });

      if (!probe.instrument) {
        throw new Error('empty instrument');
      }

      this.logger.log(
        `Instrument API check passed: ${probe.instrument.ticker} (${probe.instrument.classCode})`
      );
    } catch (error) {
      this.logger.error(
        `Instrument API probe failed: ${error instanceof Error ? error.message : String(error)}`
      );

      throw new BadRequestException(
        'The Tinkoff API token does not have access to instruments. Please create a Read-only or Full-access token (not Sandbox) in T-Invest settings'
      );
    }

    const accountsWithBalancesDto: CreateAccountWithBalancesDto[] =
      accounts.map(({ id, name }) => {
        return {
          comment: id,
          currency: 'RUB',
          id: `${TinkoffService.MANUAL_ACTIVITY_PREFIX}${id}`,
          name,
          platformId: TinkoffService.PLATFORM_ID
        };
      });

    const activitiesDto: CreateOrderDto[] = [];
    let skippedActivitiesCount = 0;

    const accountOverview = await Promise.all(
      accounts.map(async ({ id, name }) => {
        const operations = await this.getOperations({ accountId: id, token });
        const accountId = `${TinkoffService.MANUAL_ACTIVITY_PREFIX}${id}`;

        // Process oldest first so the running balance per symbol is correct
        // (BOND_REPAYMENT_FULL closes the remaining position)
        const sortedOperations = [...operations].sort((a, b) => {
          return (
            new Date(a.date ?? 0).getTime() - new Date(b.date ?? 0).getTime()
          );
        });

        const balances = new Map<string, number>();

        for (const operation of sortedOperations) {
          const activity = await this.mapOperationToActivity({
            accountId,
            balances,
            operation,
            token
          });

          if (activity) {
            activitiesDto.push(activity);
          } else {
            skippedActivitiesCount++;
          }
        }

        return { accountId, name, operationsCount: operations.length };
      })
    );

    const totalOperationsCount = skippedActivitiesCount + activitiesDto.length;
    const activitiesDtoOfSupportedSymbols =
      await this.getActivitiesOfSupportedSymbols(activitiesDto);

    skippedActivitiesCount +=
      activitiesDto.length - activitiesDtoOfSupportedSymbols.length;

    this.logger.log(
      `Syncing ${activitiesDtoOfSupportedSymbols.length} Tinkoff activities for user "${user.id}" (dry run: ${isDryRun})`
    );

    const activities = await this.importService
      .import({
        accountsWithBalancesDto,
        activitiesDto: activitiesDtoOfSupportedSymbols,
        assetProfilesWithMarketDataDto: [],
        isDryRun,
        platformsDto: [
          {
            id: TinkoffService.PLATFORM_ID,
            name: 'Тинькофф Инвестиции',
            url: 'https://www.tinkoff.ru/invest/'
          }
        ],
        tagsDto: [],
        user
      })
      .catch((error) => {
        this.logger.error(error);

        throw new BadRequestException(error.message);
      });

    if (!isDryRun) {
      await this.enrichAssetProfiles(activitiesDtoOfSupportedSymbols);
    }

    for (const { assetProfile, error } of activities.filter(({ error }) => {
      return error && error.code !== 'IS_DUPLICATE';
    })) {
      this.logger.warn(
        `Failed to import activity for "${assetProfile?.symbol}" (${assetProfile?.dataSource}): ${error?.code}`
      );
    }

    return {
      accounts: accountOverview,
      accountsCount: accounts.length,
      activitiesCount: activitiesDtoOfSupportedSymbols.length,
      duplicateActivitiesCount: activities.filter(({ error }) => {
        return error?.code === 'IS_DUPLICATE';
      }).length,
      failedActivitiesCount: activities.filter(({ error }) => {
        return error && error.code !== 'IS_DUPLICATE';
      }).length,
      importedActivitiesCount: activities.filter(({ error }) => {
        return !error;
      }).length,
      skippedActivitiesCount,
      totalOperationsCount
    };
  }

  private async getActivitiesOfSupportedSymbols(
    activitiesDto: CreateOrderDto[]
  ): Promise<CreateOrderDto[]> {
    if (activitiesDto.length === 0) {
      return [];
    }

    const symbolIds = [
      ...new Set(
        activitiesDto.map(({ symbol }) => {
          return symbol;
        })
      )
    ];

    let assetProfiles: { [assetProfileIdentifier: string]: unknown } = {};

    try {
      assetProfiles = await this.dataProviderService.getAssetProfiles(
        symbolIds.map((symbol) => {
          return { dataSource: DataSource.MOSCOW_EXCHANGE, symbol };
        })
      );
    } catch (error) {
      this.logger.error(error);
    }

    const supportedAssetProfileIdentifiers = new Set(
      Object.keys(assetProfiles)
    );

    const activitiesDtoOfSupportedSymbols = activitiesDto.filter(
      ({ symbol }) => {
        return supportedAssetProfileIdentifiers.has(
          getAssetProfileIdentifier({
            dataSource: DataSource.MOSCOW_EXCHANGE,
            symbol
          })
        );
      }
    );

    for (const { symbol } of activitiesDto) {
      if (
        !supportedAssetProfileIdentifiers.has(
          getAssetProfileIdentifier({
            dataSource: DataSource.MOSCOW_EXCHANGE,
            symbol
          })
        )
      ) {
        this.logger.warn(
          `Skipping the symbol "${symbol}" (${DataSource.MOSCOW_EXCHANGE}), because it could not be resolved by the data provider`
        );
      }
    }

    return activitiesDtoOfSupportedSymbols;
  }

  private async getAccounts(token: string): Promise<TinkoffAccount[]> {
    const response = await this.post<TinkoffGetAccountsResponse>({
      body: {},
      path: TinkoffService.GET_ACCOUNTS_PATH,
      token
    });

    return response.accounts ?? [];
  }

  private async getOperations({
    accountId,
    token
  }: {
    accountId: string;
    token: string;
  }): Promise<TinkoffOperation[]> {
    const operations: TinkoffOperation[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.post<TinkoffGetOperationsByCursorResponse>({
        body: {
          accountId,
          cursor: cursor ?? undefined,
          from: TinkoffService.OPERATIONS_FROM,
          limit: 1000,
          state: 'OPERATION_STATE_EXECUTED'
        },
        path: TinkoffService.GET_OPERATIONS_BY_CURSOR_PATH,
        token
      });

      operations.push(...(response.items ?? []));

      cursor = response.hasNext ? response.nextCursor : undefined;
    } while (cursor);

    return operations;
  }

  private async mapOperationToActivity({
    accountId,
    balances,
    operation,
    token
  }: {
    accountId: string;
    balances: Map<string, number>;
    operation: TinkoffOperation;
    token: string;
  }): Promise<CreateOrderDto | undefined> {
    const type = this.getActivityType(operation.type);

    if (!type) {
      this.logger.debug(
        `Skipping operation "${operation.id}" with unsupported type "${operation.type}"`
      );

      return undefined;
    }

    if (!operation.date) {
      this.logger.debug(
        `Skipping operation "${operation.id}" (${operation.type}) due to missing date`
      );

      return undefined;
    }

    const instrument = await this.getInstrument({ operation, token });

    if (!instrument?.ticker) {
      this.logger.debug(
        `Skipping operation "${operation.id}" (${operation.type}) due to unresolved instrument ${operation.instrumentUid ?? operation.positionUid ?? operation.figi}`
      );

      return undefined;
    }

    if (!TinkoffService.SUPPORTED_CLASS_CODES.includes(instrument.classCode)) {
      this.logger.debug(
        `Skipping operation "${operation.id}" (${operation.type}, ${instrument.ticker} ${instrument.classCode}) due to unsupported class code`
      );

      return undefined;
    }

    const payment = this.toNumber(operation.payment);
    const price = this.toNumber(operation.price);
    const symbol = `${instrument.ticker.toUpperCase()}.MOEX`;
    let unitPrice: number;
    let quantity: number;

    if (type === Type.DIVIDEND) {
      quantity = 1;
      unitPrice = new Big(payment).abs().toNumber();
    } else {
      quantity = new Big(
        operation.quantityDone ?? operation.quantity ?? '0'
      )
        .abs()
        .toNumber();
      unitPrice = new Big(price).abs().toNumber();
    }

    if (operation.type === 'OPERATION_TYPE_BOND_REPAYMENT_FULL') {
      // Full redemption closes the whole remaining position at the
      // payment-implied price (remaining nominal per bond, e.g. amortized)
      const balance = balances.get(symbol) ?? 0;

      if (balance <= 0 || payment <= 0) {
        this.logger.debug(
          `Skipping operation "${operation.id}" (${operation.type}, ${instrument.ticker}) due to zero balance or payment`
        );

        return undefined;
      }

      quantity = balance;
      unitPrice = new Big(payment).div(balance).toNumber();
    }

    if (quantity <= 0) {
      this.logger.debug(
        `Skipping operation "${operation.id}" (${operation.type}, ${instrument.ticker}) due to quantity ${operation.quantity}`
      );

      return undefined;
    }

    if (unitPrice <= 0) {
      if (
        type === Type.BUY
      ) {
        try {
          const quote = (
            await this.dataProviderService.getQuotes({
              items: [
                {
                  dataSource: DataSource.MOSCOW_EXCHANGE,
                  symbol
                }
              ]
            })
          )?.[
            getAssetProfileIdentifier({
              dataSource: DataSource.MOSCOW_EXCHANGE,
              symbol
            })
          ];

          if (quote?.marketPrice) {
            unitPrice = quote.marketPrice;
          }
        } catch (error) {
          this.logger.debug(
            `Could not resolve a market price for "${symbol}": ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (unitPrice <= 0) {
        this.logger.debug(
          `Skipping operation "${operation.id}" (${operation.type}, ${instrument.ticker}) due to unit price ${price} (payment ${payment})`
        );

        return undefined;
      }
    }

    if (type === Type.BUY) {
      balances.set(symbol, (balances.get(symbol) ?? 0) + quantity);
    } else if (type === Type.SELL) {
      balances.set(symbol, (balances.get(symbol) ?? 0) - quantity);
    }

    return {
      accountId,
      comment: operation.name || undefined,
      currency:
        operation.payment?.currency?.toUpperCase() ??
        instrument.currency?.toUpperCase() ??
        'RUB',
      dataSource: DataSource.MOSCOW_EXCHANGE,
      date: operation.date,
      fee: this.toNumber(operation.commission),
      quantity,
      symbol,
      type,
      unitPrice
    };
  }

  private async getInstrument({
    operation,
    token
  }: {
    operation: TinkoffOperation;
    token: string;
  }): Promise<TinkoffInstrument | undefined> {
    const requests = this.getInstrumentRequests(operation);

    if (requests.length === 0) {
      return undefined;
    }

    for (const request of requests) {
      if (this.instrumentsCache.has(request.id)) {
        return this.instrumentsCache.get(request.id);
      }

      try {
        this.logger.debug(
          `GetInstrumentBy request: idType=${request.idType}, id=${request.id}`
        );

        const response = await this.post<TinkoffInstrumentResponse>({
          body: request,
          path: TinkoffService.GET_INSTRUMENT_BY_PATH,
          token
        });

        if (response.instrument) {
          this.instrumentsCache.set(request.id, response.instrument);

          return response.instrument;
        }
      } catch (error) {
        this.logger.warn(
          `GetInstrumentBy failed for id=${request.id} idType=${request.idType}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return undefined;
  }

  private getInstrumentRequests(
    operation: TinkoffOperation
  ): TinkoffInstrumentRequest[] {
    const requests: TinkoffInstrumentRequest[] = [];

    if (operation.instrumentUid) {
      requests.push({
        id: operation.instrumentUid,
        idType: TinkoffService.INSTRUMENT_ID_TYPE_UID
      });
    }

    if (operation.positionUid) {
      requests.push({
        id: operation.positionUid,
        idType: TinkoffService.INSTRUMENT_ID_TYPE_POSITION_UID
      });
    }

    if (operation.figi) {
      requests.push({
        id: operation.figi,
        idType: TinkoffService.INSTRUMENT_ID_TYPE_FIGI
      });
    }

    return requests;
  }

  private getActivityType(operationType: string): Type | undefined {
    switch (operationType) {
      case 'OPERATION_TYPE_BUY':
      case 'OPERATION_TYPE_BUY_CARD':
      case 'OPERATION_TYPE_BUY_MARGIN':
      case 'OPERATION_TYPE_INPUT_SECURITIES':
        return Type.BUY;
      case 'OPERATION_TYPE_SELL':
      case 'OPERATION_TYPE_SELL_CARD':
      case 'OPERATION_TYPE_SELL_MARGIN':
      case 'OPERATION_TYPE_BOND_REPAYMENT_FULL':
        return Type.SELL;
      case 'OPERATION_TYPE_BOND_REPAYMENT':
      case 'OPERATION_TYPE_COUPON':
      case 'OPERATION_TYPE_DIVIDEND':
      case 'OPERATION_TYPE_PAYMENT':
        return Type.DIVIDEND;
      default:
        return undefined;
    }
  }

  private async post<T>({
    body,
    path,
    token
  }: {
    body: unknown;
    path: string;
    token: string;
  }): Promise<T> {
    try {
      const response = await this.fetchService.fetch(
        `${TinkoffService.BASE_URL}/${path}`,
        {
          body: JSON.stringify(body),
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          method: 'POST',
          signal: AbortSignal.timeout(TinkoffService.REQUEST_TIMEOUT)
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new BadRequestException(
          data?.message ??
            `The Tinkoff Invest API request to "${path}" failed with status ${response.status}`
        );
      }

      return data as T;
    } catch (error) {
      this.logger.error(
        `The Tinkoff Invest API request to "${path}" failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );

      throw error;
    }
  }

  private async enrichAssetProfiles(activitiesDto: CreateOrderDto[]) {
    const symbols = [...new Set(activitiesDto.map(({ symbol }) => symbol))];

    for (const symbol of symbols) {
      if (!symbol?.endsWith('.MOEX')) {
        continue;
      }

      const ticker = symbol.split('.')[0].toUpperCase();

      try {
        await this.prismaService.symbolProfile.updateMany({
          data: {
            countries: [{ code: 'RU', weight: 1 }],
            symbolMapping: {
              MOSCOW_EXCHANGE: symbol,
              YAHOO: `${ticker}.ME`
            },
            url: `https://www.moex.com/ru/issue.aspx?code=${ticker}`
          },
          where: {
            dataSource: DataSource.MOSCOW_EXCHANGE,
            symbol
          }
        });
      } catch (error) {
        this.logger.warn(
          `Failed to enrich asset profile "${symbol}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  private toNumber(money: TinkoffMoneyValue | undefined): number {
    if (!money) {
      return 0;
    }

    return new Big(money.units).plus(new Big(money.nano).div(1e9)).toNumber();
  }
}
