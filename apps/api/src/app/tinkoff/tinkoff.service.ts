import { ActivitiesService } from '@ghostfolio/api/app/activities/activities.service';
import { ImportService } from '@ghostfolio/api/app/import/import.service';
import { DataProviderService } from '@ghostfolio/api/services/data-provider/data-provider.service';
import { FetchService } from '@ghostfolio/api/services/fetch/fetch.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { PropertyService } from '@ghostfolio/api/services/property/property.service';
import {
  INVESTMENT_ACTIVITY_TYPES,
  NON_INVESTMENT_ACTIVITY_TYPES,
  PROPERTY_TINKOFF_API_TOKEN
} from '@ghostfolio/common/config';
import {
  CreateAccountWithBalancesDto,
  CreateOrderDto
} from '@ghostfolio/common/dtos';
import {
  getAssetProfileIdentifier,
  isCurrency
} from '@ghostfolio/common/helper';
import {
  AdminTinkoffDeleteResponse,
  AdminTinkoffSyncResponse,
  AdminTinkoffAccountResponse,
  Filter
} from '@ghostfolio/common/interfaces';
import { UserWithSettings } from '@ghostfolio/common/types';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource, Type } from '@prisma/client';
import { Big } from 'big.js';
import ms from 'ms';

import {
  TinkoffSyncProgress,
  TinkoffSyncStage
} from './interfaces/tinkoff-sync-progress.interface';
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
  /**
   * The commission of a trade is already reported as part of the commission of
   * the trade operation, so importing it again would count it twice. The
   * deposits and withdrawals move the own money of the user: they are not an
   * investment activity and would distort the return of the portfolio. The
   * transfers move money between the own accounts of the user and are covered
   * by the balances of the accounts. The canceled operations never took place.
   */
  private static readonly IGNORED_OPERATION_TYPES = [
    'OPERATION_TYPE_BROKER_FEE',
    'OPERATION_TYPE_CANCELED',
    'OPERATION_TYPE_INPUT',
    'OPERATION_TYPE_INP_MULTI',
    'OPERATION_TYPE_OUTPUT',
    'OPERATION_TYPE_TRANSFER',
    'OPERATION_TYPE_TRANS_IIS_BS'
  ];
  private static readonly MANUAL_ACTIVITY_PREFIX = 'tinkoff_';
  private static readonly OPERATIONS_FROM = '2000-01-01T00:00:00Z';
  private static readonly PLATFORM_ID = 'tinkoff';
  private static readonly REQUEST_TIMEOUT = ms('30 seconds');
  private static readonly RESOLVE_REQUEST_TIMEOUT = ms('30 seconds');
  private static readonly SUPPORTED_CLASS_CODES = [
    'CNGD',
    'PSAU',
    'PSBB_EQ',
    'PSSU',
    'SPBRU',
    'TQBR',
    'TQCB',
    'TQDB',
    'TQIF',
    'TQOB',
    'TQOD',
    'TQTF'
  ];

  private readonly instrumentsCache = new Map<string, TinkoffInstrument>();

  public constructor(
    private readonly activitiesService: ActivitiesService,
    private readonly dataProviderService: DataProviderService,
    private readonly fetchService: FetchService,
    private readonly importService: ImportService,
    private readonly prismaService: PrismaService,
    private readonly propertyService: PropertyService
  ) {}

  public async deleteAllImported({
    importSourceId,
    user
  }: {
    importSourceId?: string;
    user: UserWithSettings;
  }): Promise<AdminTinkoffDeleteResponse> {
    const accounts = await this.prismaService.account.findMany({
      select: { id: true },
      where: {
        ...(importSourceId
          ? // The accounts of an import source which was created before the
            // accounts were linked to it are not distinguishable, so the
            // prefix of the account ID is used as a fallback
            { OR: [{ importSourceId }, { importSourceId: null }] }
          : {}),
        id: { startsWith: TinkoffService.MANUAL_ACTIVITY_PREFIX },
        userId: user.id
      }
    });

    if (accounts.length === 0) {
      return { deletedAccountsCount: 0, deletedActivitiesCount: 0 };
    }

    const filters: Filter[] = accounts.map(({ id }) => {
      return { id, type: 'ACCOUNT' };
    });

    const deletedActivitiesCount =
      await this.activitiesService.deleteActivities({
        filters,
        userId: user.id
      });

    const { count: deletedAccountsCount } =
      await this.prismaService.account.deleteMany({
        where: {
          id: { in: accounts.map(({ id }) => id) },
          userId: user.id
        }
      });

    this.logger.log(
      `Deleted ${deletedActivitiesCount} activities in ${deletedAccountsCount} Tinkoff accounts for user "${user.id}"`
    );

    return { deletedAccountsCount, deletedActivitiesCount };
  }

  public async getAccountsForPreview({
    apiKey
  }: {
    apiKey?: string;
  } = {}): Promise<AdminTinkoffAccountResponse> {
    const token = await this.resolveApiToken({ apiKey });

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
    } catch (error) {
      this.logger.error(
        `Instrument API probe failed: ${error instanceof Error ? error.message : String(error)}`
      );

      throw new BadRequestException(
        'The Tinkoff API token does not have access to instruments. Please create a Read-only or Full-access token (not Sandbox) in T-Invest settings'
      );
    }

    return {
      accounts: accounts.map(({ id, name, type, status }) => ({
        id,
        name,
        type,
        status
      }))
    };
  }

  public async sync({
    accountIds,
    apiKey,
    importSourceId,
    isDryRun,
    onProgress,
    user
  }: {
    accountIds?: string[];
    apiKey?: string;
    importSourceId?: string;
    isDryRun: boolean;
    onProgress?: (progress: TinkoffSyncProgress) => void;
    user: UserWithSettings;
  }): Promise<AdminTinkoffSyncResponse> {
    const token = await this.resolveApiToken({ apiKey });

    if (!token) {
      throw new BadRequestException(
        'The Tinkoff API token is not configured in the admin settings'
      );
    }

    onProgress?.({ stage: TinkoffSyncStage.CONNECTING });

    const allAccounts = await this.getAccounts(token);

    if (allAccounts.length === 0) {
      throw new BadRequestException(
        'No Tinkoff accounts have been found for the API token'
      );
    }

    // Filter accounts if accountIds provided
    const accounts = accountIds?.length
      ? allAccounts.filter((account) => accountIds.includes(account.id))
      : allAccounts;

    if (accounts.length === 0) {
      throw new BadRequestException(
        'No matching Tinkoff accounts found for the provided account IDs'
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

    onProgress?.({ stage: TinkoffSyncStage.FETCHING_OPERATIONS });

    const accountsWithBalancesDto: CreateAccountWithBalancesDto[] =
      accounts.map(({ id, name }) => {
        return {
          comment: id,
          currency: 'RUB',
          id: `${TinkoffService.MANUAL_ACTIVITY_PREFIX}${id}`,
          importSourceId,
          name,
          platformId: TinkoffService.PLATFORM_ID
        };
      });

    const activitiesDto: CreateOrderDto[] = [];
    let processedOperationsCount = 0;
    let skippedActivitiesCount = 0;
    const accountOverview: AdminTinkoffSyncResponse['accounts'] = [];

    // The accounts are processed one after another so that the progress can be
    // reported per account and the per symbol running balances stay correct.
    for (const { id, name } of accounts) {
      const operations = await this.getOperations({ accountId: id, token });
      const accountId = `${TinkoffService.MANUAL_ACTIVITY_PREFIX}${id}`;

      processedOperationsCount += operations.length;

      onProgress?.({
        accountsCount: accounts.length,
        processedAccountsCount: accountOverview.length,
        processedOperationsCount,
        stage: `${TinkoffSyncStage.MAPPING_OPERATIONS}: ${name}`
      });

      // Process oldest first so the running balance per symbol is correct
      // (BOND_REPAYMENT_FULL closes the remaining position)
      const sortedOperations = [...operations].sort((a, b) => {
        return (
          new Date(a.date ?? 0).getTime() - new Date(b.date ?? 0).getTime()
        );
      });

      const amortizationPayouts = new Map<string, number>();
      const balances = new Map<string, number>();

      for (const operation of sortedOperations) {
        const activity = await this.mapOperationToActivity({
          accountId,
          amortizationPayouts,
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

      accountOverview.push({
        accountId,
        name,
        operationsCount: operations.length
      });
    }

    const totalOperationsCount = skippedActivitiesCount + activitiesDto.length;

    onProgress?.({
      activitiesCount: activitiesDto.length,
      processedAccountsCount: accounts.length,
      processedOperationsCount,
      stage: TinkoffSyncStage.RESOLVING_SYMBOLS,
      totalOperationsCount
    });

    const activitiesDtoOfSupportedSymbols =
      await this.getActivitiesOfSupportedSymbols(activitiesDto, onProgress);

    skippedActivitiesCount +=
      activitiesDto.length - activitiesDtoOfSupportedSymbols.length;

    this.logger.log(
      `Syncing ${activitiesDtoOfSupportedSymbols.length} of ${activitiesDto.length} mapped Tinkoff activities (${skippedActivitiesCount} skipped by the data provider) for user "${user.id}" (dry run: ${isDryRun})`
    );

    if (activitiesDtoOfSupportedSymbols.length === 0) {
      throw new BadRequestException(
        'None of the Tinkoff activities could be resolved by the Moscow Exchange data provider. Please check the API logs for the underlying data provider errors'
      );
    }

    onProgress?.({
      activitiesCount: activitiesDtoOfSupportedSymbols.length,
      stage: TinkoffSyncStage.IMPORTING_ACTIVITIES
    });

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
      onProgress?.({ stage: TinkoffSyncStage.ENRICHING_ASSET_PROFILES });

      await this.enrichAssetProfiles(activitiesDtoOfSupportedSymbols);
    }

    onProgress?.({ stage: TinkoffSyncStage.DONE });

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

  /**
   * Tinkoff reports a split with a dedicated ticker, which is suffixed with an
   * at sign, for example TMOS@. The operations belong to the security itself,
   * so the suffix is removed to keep the position in a single asset.
   */
  private static normalizeTicker(ticker: string | undefined): string {
    return ticker?.trim().replace(/@$/, '').toUpperCase();
  }

  private async resolveApiToken({
    apiKey
  }: {
    apiKey?: string;
  }): Promise<string | undefined> {
    const token =
      apiKey?.trim() ||
      (
        await this.propertyService.getByKey<string>(PROPERTY_TINKOFF_API_TOKEN)
      )?.trim();

    return token || undefined;
  }

  private async getActivitiesOfSupportedSymbols(
    activitiesDto: CreateOrderDto[],
    onProgress?: (progress: TinkoffSyncProgress) => void
  ): Promise<CreateOrderDto[]> {
    if (activitiesDto.length === 0) {
      return [];
    }

    // The cash flows are not backed by a security of the exchange, so they must
    // not be filtered by the data provider.
    const investmentActivities = activitiesDto.filter(({ type }) => {
      return INVESTMENT_ACTIVITY_TYPES.includes(type);
    });

    const symbolIds = [
      ...new Set(
        investmentActivities.map(({ symbol }) => {
          return symbol;
        })
      )
    ];

    const supportedSymbols = await this.resolveSupportedSymbols(
      symbolIds,
      onProgress
    );

    const activitiesDtoOfSupportedSymbols = activitiesDto.filter(
      ({ symbol, type }) => {
        return (
          !INVESTMENT_ACTIVITY_TYPES.includes(type) ||
          supportedSymbols.has(symbol)
        );
      }
    );

    for (const symbol of symbolIds) {
      if (!supportedSymbols.has(symbol)) {
        this.logger.warn(
          `Skipping the symbol "${symbol}" (${DataSource.MOSCOW_EXCHANGE}), because it could not be resolved by the data provider`
        );
      }
    }

    return activitiesDtoOfSupportedSymbols;
  }

  /**
   * Resolves the symbols one by one against the data provider. A single failed
   * request must not discard the whole import: getAssetProfiles() rejects all
   * results if any of its requests fails, which would silently drop every
   * activity of a sync.
   */
  private async resolveSupportedSymbols(
    symbols: string[],
    onProgress?: (progress: TinkoffSyncProgress) => void,
    concurrency = 5
  ): Promise<Set<string>> {
    const supportedSymbols = new Set<string>();
    const dataProvider = this.dataProviderService.getDataProvider(
      DataSource.MOSCOW_EXCHANGE
    );

    const queue = [...symbols];
    let processedCount = 0;

    const workers = Array.from(
      { length: Math.min(concurrency, queue.length) },
      async () => {
        while (queue.length > 0) {
          const symbol = queue.shift();

          try {
            const assetProfile = await dataProvider.getAssetProfile({
              requestTimeout: TinkoffService.RESOLVE_REQUEST_TIMEOUT,
              symbol
            });

            if (isCurrency(assetProfile?.currency)) {
              supportedSymbols.add(symbol);
            } else {
              this.logger.warn(
                `The asset profile of "${symbol}" (${DataSource.MOSCOW_EXCHANGE}) has no valid currency`
              );
            }
          } catch (error) {
            this.logger.warn(
              `Could not resolve the symbol "${symbol}" (${DataSource.MOSCOW_EXCHANGE}): ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          } finally {
            processedCount++;

            onProgress?.({
              stage: `${TinkoffSyncStage.RESOLVING_SYMBOLS} (${processedCount}/${symbols.length})`
            });
          }
        }
      }
    );

    await Promise.all(workers);

    this.logger.log(
      `Resolved ${supportedSymbols.size} of ${symbols.length} symbols (${DataSource.MOSCOW_EXCHANGE})`
    );

    return supportedSymbols;
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
    amortizationPayouts,
    balances,
    operation,
    token
  }: {
    accountId: string;
    amortizationPayouts: Map<string, number>;
    balances: Map<string, number>;
    operation: TinkoffOperation;
    token: string;
  }): Promise<CreateOrderDto | undefined> {
    if (!operation.date) {
      this.logger.debug(
        `Skipping operation "${operation.id}" (${operation.type}) due to missing date`
      );

      return undefined;
    }

    if (TinkoffService.IGNORED_OPERATION_TYPES.includes(operation.type)) {
      this.logger.debug(
        `Skipping operation "${operation.id}" (${operation.type}, ${operation.description}) because it does not represent an independent change of the portfolio`
      );

      return undefined;
    }

    const payment = this.toNumber(operation.payment);
    const type = this.getActivityType(operation.type);

    if (!type) {
      this.logger.debug(
        `Skipping operation "${operation.id}" with unsupported type "${operation.type}"`
      );

      return undefined;
    }

    // The cash flows and the withheld taxes are not backed by a security of
    // the exchange, so they are recorded against the currency of the payment.
    if (NON_INVESTMENT_ACTIVITY_TYPES.includes(type)) {
      return this.mapCashFlowToActivity({
        accountId,
        operation,
        payment,
        type
      });
    }

    // The ticker and the class code of the operation itself identify the
    // security. The instrument is not a reliable source: for the operations of
    // a corporate event, for example the exchange of a share for another one,
    // the instrument of the position it was converted into is reported.
    const ticker = TinkoffService.normalizeTicker(operation.ticker);

    if (!ticker) {
      this.logger.debug(
        `Skipping operation "${operation.id}" (${operation.type}) due to a missing ticker`
      );

      return undefined;
    }

    if (!TinkoffService.SUPPORTED_CLASS_CODES.includes(operation.classCode)) {
      this.logger.debug(
        `Skipping operation "${operation.id}" (${operation.type}, ${ticker} ${operation.classCode}) due to unsupported class code`
      );

      return undefined;
    }

    const instrument = await this.getInstrument({ operation, token });
    const price = this.toNumber(operation.price);
    const symbol = `${ticker}.MOEX`;
    let unitPrice: number;
    let quantity: number;

    if (type === Type.DIVIDEND) {
      quantity = 1;
      unitPrice = new Big(payment).abs().toNumber();
    } else {
      quantity = new Big(operation.quantityDone ?? operation.quantity ?? '0')
        .abs()
        .toNumber();
      unitPrice = new Big(price).abs().toNumber();
    }

    if (type === Type.SELL) {
      // A position can be closed only with the securities it holds. Tinkoff
      // reports the securities of a corporate event, such as a split or an
      // exchange, without a corresponding acquisition, which would turn the
      // holding into a short position.
      const balance = balances.get(symbol) ?? 0;

      if (balance <= 0) {
        this.logger.warn(
          `Skipping the sale of ${quantity} "${symbol}" (${operation.description ?? operation.type}), because the position does not hold any of it`
        );

        return undefined;
      }

      if (quantity > balance) {
        this.logger.warn(
          `Reducing the sale of ${quantity} "${symbol}" (${operation.description ?? operation.type}) to the ${balance} securities of the position, the remaining ${quantity - balance} have no acquisition`
        );

        quantity = balance;
      }
    }

    if (operation.type === 'OPERATION_TYPE_BOND_REPAYMENT') {
      // The partial redemption of an amortizing bond does not change the
      // number of the bonds, but it returns a part of the nominal. The payout
      // is accumulated and settled together with the final redemption, so that
      // the position is closed at its proceeds instead of at the remaining
      // nominal per bond.
      amortizationPayouts.set(
        symbol,
        (amortizationPayouts.get(symbol) ?? 0) + Math.abs(payment)
      );

      return undefined;
    }

    if (operation.type === 'OPERATION_TYPE_BOND_REPAYMENT_FULL') {
      // Full redemption closes the whole remaining position at the
      // payment-implied price (remaining nominal per bond, e.g. amortized)
      const balance = balances.get(symbol) ?? 0;

      if (balance <= 0 || payment <= 0) {
        this.logger.debug(
          `Skipping operation "${operation.id}" (${operation.type}, ${ticker}) due to zero balance or payment`
        );

        return undefined;
      }

      // The proceeds of the position consist of the final redemption and the
      // partial redemptions accumulated before it. Without them, the position
      // of an amortizing bond would be closed at its remaining nominal, which
      // is unrelated to the price it was bought at.
      const proceeds =
        Math.abs(payment) + (amortizationPayouts.get(symbol) ?? 0);

      amortizationPayouts.delete(symbol);

      quantity = balance;
      unitPrice = new Big(proceeds).div(balance).toNumber();
    }

    if (quantity <= 0) {
      this.logger.debug(
        `Skipping operation "${operation.id}" (${operation.type}, ${ticker}) due to quantity ${operation.quantity}`
      );

      return undefined;
    }

    if (unitPrice <= 0) {
      if (type === Type.BUY && operation.date) {
        // Use the historical market price at the operation date (not the
        // live quote): the price must be deterministic across syncs,
        // otherwise duplicate detection (strict unitPrice equality) fails
        // and every sync creates another activity
        try {
          const dateString = operation.date.slice(0, 10);

          const historical = await this.dataProviderService.getHistoricalRaw({
            assetProfileIdentifiers: [
              {
                dataSource: DataSource.MOSCOW_EXCHANGE,
                symbol
              }
            ],
            from: new Date(
              new Date(operation.date).getTime() - 7 * 24 * 3600 * 1000
            ),
            to: new Date(operation.date)
          });

          const prices =
            historical[
              getAssetProfileIdentifier({
                dataSource: DataSource.MOSCOW_EXCHANGE,
                symbol
              })
            ] ?? {};

          const latestDateString = Object.keys(prices)
            .filter((key) => {
              return key <= dateString;
            })
            .sort()
            .pop();

          const marketPrice =
            latestDateString === undefined
              ? undefined
              : prices[latestDateString]?.marketPrice;

          if (marketPrice) {
            unitPrice = marketPrice;
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
      currency: this.getActivityCurrency({ instrument, operation, type }),
      dataSource: DataSource.MOSCOW_EXCHANGE,
      date: operation.date,
      // Tinkoff reports the commission as a negative amount for every
      // operation. Ghostfolio treats the fee as a positive cost and subtracts
      // it from the cash flow, hence the absolute value is required.
      fee: new Big(this.toNumber(operation.commission)).abs().toNumber(),
      quantity,
      symbol,
      type,
      unitPrice
    };
  }

  /**
   * Maps an operation which does not belong to a security, for example a
   * withheld tax, to a cash flow of the account. The currency of the payment is
   * used as the symbol, which creates a custom asset profile of the currency,
   * the same way a manually entered cash movement is represented in
   * Ghostfolio.
   */
  private mapCashFlowToActivity({
    accountId,
    operation,
    payment,
    type
  }: {
    accountId: string;
    operation: TinkoffOperation;
    payment: number;
    type: Type;
  }): CreateOrderDto | undefined {
    const currency =
      operation.payment?.currency?.toUpperCase() ??
      operation.price?.currency?.toUpperCase();

    if (!currency || !isCurrency(currency)) {
      this.logger.debug(
        `Skipping operation "${operation.id}" (${operation.type}) due to an unsupported currency "${currency}"`
      );

      return undefined;
    }

    const amount = new Big(payment).abs().toNumber();

    if (amount <= 0) {
      return undefined;
    }

    const description = operation.description || operation.name;
    const name = operation.name;

    return {
      accountId,
      comment:
        description && name && description !== name
          ? `${description} (${name})`
          : (description ?? undefined),
      currency,
      date: operation.date,
      fee: new Big(this.toNumber(operation.commission)).abs().toNumber(),
      quantity: 1,
      symbol: currency,
      type,
      unitPrice: amount
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

  /**
   * The amounts of an operation are reported in the currency of the traded
   * instrument, which is not necessarily the currency of the payment: the
   * redemption of a bond denominated in USD is paid out in RUB, for example.
   * The unit price therefore defines the currency of a trade, while the payment
   * defines it for the income operations.
   */
  private getActivityCurrency({
    instrument,
    operation,
    type
  }: {
    instrument: TinkoffInstrument;
    operation: TinkoffOperation;
    type: Type;
  }) {
    const currency =
      type === Type.DIVIDEND
        ? operation.payment?.currency
        : (operation.price?.currency ?? operation.payment?.currency);

    return (
      currency?.toUpperCase() ?? instrument.currency?.toUpperCase() ?? 'RUB'
    );
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
      case 'OPERATION_TYPE_COUPON':
      case 'OPERATION_TYPE_DIVIDEND':
      case 'OPERATION_TYPE_DIV_EXT':
      case 'OPERATION_TYPE_PAYMENT':
        return Type.DIVIDEND;
      case 'OPERATION_TYPE_BOND_TAX':
      case 'OPERATION_TYPE_DIVIDEND_TAX':
      case 'OPERATION_TYPE_TAX':
      case 'OPERATION_TYPE_TAX_CORRECTION':
        return Type.FEE;
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
