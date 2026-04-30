import { Controller, Get, Header, Param, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PackageCacheService } from './package-cache.service';

@ApiTags('packages')
@Controller('/packages')
export class PackagesController {
  constructor(private readonly cache: PackageCacheService) {}

  @Get('/cache/status')
  status() {
    return this.cache.status();
  }

  @Get('/cache/:packageArtifactId')
  @Header('content-type', 'application/octet-stream')
  download(@Param('packageArtifactId') packageArtifactId: string) {
    return new StreamableFile(this.cache.stream(packageArtifactId));
  }
}
