import { AllowDuringImpersonation } from '@ghostfolio/api/decorators/allow-during-impersonation.decorator';
import { HasPermission } from '@ghostfolio/api/decorators/has-permission.decorator';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { AdminTinkoffSyncResponse } from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';
import type { RequestWithUser } from '@ghostfolio/common/types';

import { Controller, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { TinkoffService } from './tinkoff.service';

@AllowDuringImpersonation()
@Controller('admin/tinkoff')
export class TinkoffController {
  public constructor(
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly tinkoffService: TinkoffService
  ) {}

  @Post('sync')
  @HasPermission(permissions.accessAdminControl)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async sync(
    @Query('dryRun') isDryRunParam = 'false'
  ): Promise<AdminTinkoffSyncResponse> {
    return this.tinkoffService.sync({
      isDryRun: isDryRunParam === 'true',
      user: this.request.user
    });
  }
}
