import { IsString } from 'class-validator';

export class CreateImportSourceDto {
  @IsString()
  name: string;

  @IsString()
  type: string;

  @IsString()
  apiKey: string;
}