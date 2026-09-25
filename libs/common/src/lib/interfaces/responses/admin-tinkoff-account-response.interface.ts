export interface AdminTinkoffAccountResponse {
  accounts: {
    id: string;
    name: string;
    type: string;
    status: string;
  }[];
}