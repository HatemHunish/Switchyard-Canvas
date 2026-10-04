import { DynamicModule, Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { existsSync } from 'fs';
import { join } from 'path';
import { AgentRunnerService } from './engine/agent-runner.service';
import { AppToolsService } from './engine/app-tools.service';
import { InternalToolsController } from './engine/internal-tools.controller';
import { EventBus } from './engine/event-bus';
import { ExecutorService } from './engine/executor.service';
import { InboxService } from './engine/inbox.service';
import { ProcessQueue } from './engine/queue';
import { NotifyTestController, ReviewPageController } from './engine/review-page.controller';
import { RunsController } from './engine/runs.controller';
import { RunsStore } from './engine/runs.store';
import { ActionsService } from './actions/actions.service';
import { DashboardController } from './dashboard/dashboard.controller';
import { ExportService } from './export/export.service';
import { FilesController } from './output/files.controller';
import { MemoryController } from './memory/memory.controller';
import { MemoryService } from './memory/memory.service';
import { DatasetsController } from './datasets/datasets.controller';
import { DatasetsService } from './datasets/datasets.service';
import { PluginsController } from './plugins/plugins.controller';
import { PluginsService } from './plugins/plugins.service';
import { AssistantController } from './assistant/assistant.controller';
import { AssistantService } from './assistant/assistant.service';
import { SystemController } from './system/system.controller';
import { HooksController } from './triggers/hooks.controller';
import { TriggersService } from './triggers/triggers.service';
import { WorkflowsController } from './workflows/workflows.controller';
import { WorkflowsService } from './workflows/workflows.service';

// Serve the built SPA only when it exists (production). In dev the client runs
// under Vite on its own port and proxies /api here, so we skip static serving.
const clientDist = join(__dirname, '..', 'client', 'dist');
const staticImports: DynamicModule[] = existsSync(join(clientDist, 'index.html'))
  ? [ServeStaticModule.forRoot({ rootPath: clientDist, exclude: ['/api/(.*)', '/r/(.*)'] })]
  : [];

@Module({
  imports: [...staticImports],
  controllers: [WorkflowsController, RunsController, HooksController, SystemController, MemoryController, FilesController, DashboardController, ReviewPageController, NotifyTestController, PluginsController, DatasetsController, AssistantController, InternalToolsController],
  providers: [WorkflowsService, RunsStore, EventBus, ProcessQueue, AgentRunnerService, ExecutorService, InboxService, MemoryService, ActionsService, TriggersService, ExportService, PluginsService, DatasetsService, AssistantService, AppToolsService],
})
export class AppModule {}
