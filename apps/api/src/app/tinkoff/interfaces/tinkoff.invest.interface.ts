export interface TinkoffMoneyValue {
  units: string;
  nano: number;
  currency: string;
}

export interface TinkoffAccount {
  id: string;
  type: string;
  name: string;
  status: string;
  openedDate?: string;
  closedDate?: string;
  accessLevel?: string;
}

export interface TinkoffOperation {
  id: string;
  parentOperationId?: string;
  name?: string;
  date?: string;
  type?: string;
  description?: string;
  state?: string;
  figi?: string;
  instrumentType?: string;
  instrumentKind?: string;
  positionUid?: string;
  instrumentUid?: string;
  assetUid?: string;
  payment?: TinkoffMoneyValue;
  price?: TinkoffMoneyValue;
  commission?: TinkoffMoneyValue;
  quantity?: string;
  quantityRest?: string;
  quantityDone?: string;
  tradesInfo?: {
    trades: {
      figi?: string;
      price?: TinkoffMoneyValue;
      quantity?: string;
    }[];
  };
  cancelReason?: string;
}

export interface TinkoffInstrumentRequest {
  idType: string;
  classCode?: string;
  id: string;
}

export interface TinkoffInstrument {
  figi?: string;
  ticker?: string;
  classCode?: string;
  currency?: string;
  name?: string;
  exchange?: string;
  instrumentType?: string;
  instrumentKind?: string;
  uid?: string;
  positionUid?: string;
}

export interface TinkoffInstrumentResponse {
  instrument?: TinkoffInstrument;
}

export interface TinkoffGetAccountsResponse {
  accounts?: TinkoffAccount[];
  count?: string;
}

export interface TinkoffGetOperationsByCursorResponse {
  hasNext?: boolean;
  nextCursor?: string;
  items?: TinkoffOperation[];
}
