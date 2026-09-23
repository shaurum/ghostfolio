import { FetchModule } from '@ghostfolio/api/services/fetch/fetch.module';
import { PrismaModule } from '@ghostfolio/api/services/prisma/prisma.module';

import { Module } from '@nestjs/common';

import { EnrichmentController } from './enrichment.controller';
import { EnrichmentService } from './enrichment.service';

@Module({
  controllers: [EnrichmentController],
  imports: [FetchModule, PrismaModule],
  providers: [EnrichmentService]
})
export class EnrichmentModule {}
