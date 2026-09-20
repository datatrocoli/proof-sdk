import type { Express, Router } from 'express';
import { agentRoutes } from '../../../server/agent-routes.js';
import { bridgeRouter, createBridgeMountRouter } from '../../../server/bridge.js';
import { getCollabRuntime, startCollabRuntime, startCollabRuntimeEmbedded } from '../../../server/collab.js';
import { apiRoutes, handleShareMarkdown, shareMarkdownBodyParser } from '../../../server/routes.js';
import { shareWebRoutes } from '../../../server/share-web-routes.js';

export function createDocumentRouter(): Router {
  return apiRoutes;
}

export function createShareRouter(): Router {
  return shareWebRoutes;
}

export function createAgentRouter(): Router {
  return agentRoutes;
}

export function createBridgeRouter(): Router {
  return bridgeRouter;
}

export function createCollabRuntime() {
  return getCollabRuntime();
}

export function mountProofSdkRoutes(app: Express): void {
  app.post('/documents', apiRoutes);
  app.use('/documents', createBridgeMountRouter());
  app.use('/documents', agentRoutes);
  app.use(apiRoutes);
  app.use(shareWebRoutes);
}

export {
  agentRoutes,
  apiRoutes,
  bridgeRouter,
  getCollabRuntime,
  handleShareMarkdown,
  shareMarkdownBodyParser,
  shareWebRoutes,
  startCollabRuntime,
  startCollabRuntimeEmbedded,
};
