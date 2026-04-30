import { Body, Controller, Get, Header, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsString, IsUrl } from 'class-validator';
import { ManagementService } from './management/management.service';

class BackendSetupDto {
  @IsUrl({ require_tld: false })
  managementUrl!: string;

  @IsString()
  nodeId!: string;

  @IsString()
  nodeEnrollmentToken!: string;

  @IsUrl({ require_tld: false })
  nodePublicUrl!: string;

  @IsUrl({ require_tld: false })
  dragonflyUrl!: string;
}

@ApiTags('setup')
@Controller('/setup')
export class SetupController {
  constructor(private readonly management: ManagementService) {}

  @Get()
  @Header('content-type', 'text/html')
  page() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>1Patch Backend Node Setup</title><style>body{font-family:system-ui;margin:0;background:#f7f8fb;color:#18202f}.wrap{max-width:760px;margin:48px auto;padding:24px}label{display:block;margin:16px 0 6px;font-weight:700}input{width:100%;padding:12px;border:1px solid #ccd3df;border-radius:8px}button{margin-top:20px;padding:12px 16px;border:0;border-radius:8px;background:#1463ff;color:white;font-weight:800}pre{white-space:pre-wrap;background:#111827;color:#e5e7eb;padding:16px;border-radius:8px}</style></head><body><main class="wrap"><h1>1Patch Backend Node Setup</h1><form id="setup"><label>Management URL</label><input name="managementUrl" value="https://manage.1patch.local" required><label>Node ID</label><input name="nodeId" required><label>Enrollment token</label><input name="nodeEnrollmentToken" required><label>Node public URL</label><input name="nodePublicUrl" value="https://node-1.1patch.local" required><label>DragonflyDB URL</label><input name="dragonflyUrl" value="redis://localhost:6380" required><button>Generate node config</button></form><pre id="out"></pre></main><script>setup.onsubmit=async(e)=>{e.preventDefault();const data=Object.fromEntries(new FormData(setup).entries());const r=await fetch('/setup/configuration',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});out.textContent=JSON.stringify(await r.json(),null,2)}</script></body></html>`;
  }

  @Post('/configuration')
  configuration(@Body() dto: BackendSetupDto) {
    return {
      env: {
        MANAGEMENT_URL: dto.managementUrl,
        NODE_ID: dto.nodeId,
        NODE_ENROLLMENT_TOKEN: dto.nodeEnrollmentToken,
        NODE_PUBLIC_URL: dto.nodePublicUrl,
        DRAGONFLY_URL: dto.dragonflyUrl,
      },
      powershell: `./scripts/setup-backend-node.ps1 -ManagementUrl '${dto.managementUrl}' -NodeId '${dto.nodeId}' -NodeEnrollmentToken '${dto.nodeEnrollmentToken}' -NodePublicUrl '${dto.nodePublicUrl}' -DragonflyUrl '${dto.dragonflyUrl}'`,
      nextSteps: ['Run the generated setup script.', 'Start the backend node.', 'Run POST /node/register once to enroll it.'],
    };
  }

  @Post('/register')
  register() {
    return this.management.register();
  }

  @Get('/health-check')
  healthCheck() {
    return {
      nodeId: process.env.NODE_ID,
      managementUrl: process.env.MANAGEMENT_URL,
      dragonflyUrlConfigured: Boolean(process.env.DRAGONFLY_URL),
    };
  }
}
