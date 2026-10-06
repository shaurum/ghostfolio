export interface AdminTinkoffSyncStatus {
  accountsCount: number;
  activitiesCount: number;
  error?: string;
  finishedAt?: string;
  importSourceId: string;
  isRunning: boolean;
  processedAccountsCount: number;
  processedOperationsCount: number;
  result?: {
    accountsCount: number;
    activitiesCount: number;
    duplicateActivitiesCount: number;
    failedActivitiesCount: number;
    importedActivitiesCount: number;
    skippedActivitiesCount: number;
    totalOperationsCount: number;
  };
  startedAt?: string;
  stage: string;
  totalOperationsCount?: number;
  updatedAt: string;
}
