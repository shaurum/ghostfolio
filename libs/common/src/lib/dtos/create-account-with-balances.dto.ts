import { AccountBalance } from '@ghostfolio/common/interfaces';

import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

import { CreateAccountDto } from './create-account.dto';

export class CreateAccountWithBalancesDto extends CreateAccountDto {
  @IsArray()
  @IsOptional()
  balances?: AccountBalance[];

  /**
   * Identifies the import source the account belongs to, so that its activities
   * can be removed again together with the source.
   */
  @IsString()
  @IsOptional()
  importSourceId?: string;

  /**
   * @deprecated Accepted for backward compatibility with old export files
   * and mapped to the "Exclude from Analysis" tag (`TAG_ID_EXCLUDE_FROM_ANALYSIS`)
   */
  @IsBoolean()
  @IsOptional()
  isExcluded?: boolean;
}
