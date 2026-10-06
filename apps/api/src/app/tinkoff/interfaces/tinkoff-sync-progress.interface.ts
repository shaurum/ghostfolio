export const TinkoffSyncStage = {
  CONNECTING: 'Подключение к API',
  DONE: 'Готово',
  ENRICHING_ASSET_PROFILES: 'Обновление профилей активов',
  FETCHING_OPERATIONS: 'Загрузка операций',
  IMPORTING_ACTIVITIES: 'Импорт активностей',
  MAPPING_OPERATIONS: 'Обработка операций',
  RESOLVING_SYMBOLS: 'Проверка символов'
} as const;

export interface TinkoffSyncProgress {
  accountsCount?: number;
  activitiesCount?: number;
  processedAccountsCount?: number;
  processedOperationsCount?: number;
  stage: string;
  totalOperationsCount?: number;
}
