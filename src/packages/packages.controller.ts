import { Controller, Get, Header, Param, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PackageCacheService } from './package-cache.service';

@ApiTags('packages')
@Controller('/packages')
export class PackagesController {
  /**
   * Creates a PackagesController instance with its required collaborators.
   *
   * @param cache cache supplied to the function.
   */
  constructor(private readonly cache: PackageCacheService) {}

  /**
   * Handles the status operation for PackagesController.
   * @returns The result produced by the operation.
   */
  @Get('/cache/status')
  status() {
    return this.cache.status();
  }

  /**
   * Handles the download operation for PackagesController.
   *
   * @param packageArtifactId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  @Get('/cache/:packageArtifactId')
  @Header('content-type', 'application/octet-stream')
  async download(@Param('packageArtifactId') packageArtifactId: string) {
    return new StreamableFile(await this.cache.stream(packageArtifactId));
  }
}
