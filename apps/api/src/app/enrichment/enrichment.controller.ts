import { AllowDuringImpersonation } from '@ghostfolio/api/decorators/allow-during-impersonation.decorator';
import { HasPermission } from '@ghostfolio/api/decorators/has-permission.decorator';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { AdminEnrichmentResponse } from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';

import { Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { EnrichmentService } from './enrichment.service';

@AllowDuringImpersonation()
@Controller('admin/enrichment')
export class EnrichmentController {
  public constructor(private readonly enrichmentService: EnrichmentService) {}

  @Post('sheet')
  @HasPermission(permissions.accessAdminControl)
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  public async enrichFromSheet(): Promise<AdminEnrichmentResponse> {
    return this.enrichmentService.enrichFromSheet();
  }
}
