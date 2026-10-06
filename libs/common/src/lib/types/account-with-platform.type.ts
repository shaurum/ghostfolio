import { Account, Platform, Tag } from '@prisma/client';

export type AccountWithPlatform = Omit<Account, 'importSourceId'> & {
  platform?: Platform;
  tags?: Tag[];
};
