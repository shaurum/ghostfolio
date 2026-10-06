import { Account as AccountModel } from '@prisma/client';

export type AccountWithBalance = Omit<AccountModel, 'importSourceId'> & {
  balance: number;
};
