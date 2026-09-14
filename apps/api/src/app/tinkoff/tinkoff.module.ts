import { ImportModule } from '@ghostfolio/api/app/import/import.module';
import { ConfigurationModule } from '@ghostfolio/api/services/configuration/configuration.module';
import { DataProviderModule } from '@ghostfolio/api/services/data-provider/data-provider.module';
import { FetchModule } from '@ghostfolio/api/services/fetch/fetch.module';
import { PropertyModule } from '@ghostfolio/api/services/property/property.module';

import { Module } from '@nestjs/common';

import { TinkoffController } from './tinkoff.controller';
import { TinkoffService } from './tinkoff.service';

@Module({
  controllers: [TinkoffController],
  imports: [
    ConfigurationModule,
    DataProviderModule,
    FetchModule,
    ImportModule,
    PropertyModule
  ],
  providers: [TinkoffService]
})
export class TinkoffModule {}
