export interface AdminTinkoffSyncResponse {
  accounts: {
    accountId: string;
    name: string;
    operationsCount: number;
  }[];
  accountsCount: number;
  totalOperationsCount: number;
  activitiesCount: number;
  importedActivitiesCount: number;
  duplicateActivitiesCount: number;
  failedActivitiesCount: number;
  skippedActivitiesCount: number;
}
