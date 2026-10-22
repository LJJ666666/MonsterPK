import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";
import { traeBadgePlugin } from 'vite-plugin-trae-solo-badge';
import fs from 'fs';
import path from 'path';

function localSaveMiddleware(req: any, res: any, next: any) {
  if (req.url === '/api/save' && req.method === 'GET') {
    const savePath = path.resolve(process.cwd(), 'save_data.json');
    if (fs.existsSync(savePath)) {
      res.setHeader('Content-Type', 'application/json');
      res.end(fs.readFileSync(savePath, 'utf-8'));
    } else {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } else if (req.url === '/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk: any) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const savePath = path.resolve(process.cwd(), 'save_data.json');
        fs.writeFileSync(savePath, data.value, 'utf-8');
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    });
  } else {
    next();
  }
}

function localSavePlugin(): Plugin {
  return {
    name: 'local-save-plugin',
    configureServer(server) {
      server.middlewares.use(localSaveMiddleware);
    },
    // 生产预览（vite preview）同样挂载存档接口，避免被 SPA 回退成 index.html
    configurePreviewServer(server) {
      server.middlewares.use(localSaveMiddleware);
    }
  };
}

// https://vite.dev/config/
export default defineConfig({
  build: {
    sourcemap: 'hidden',
  },
  plugins: [
    react({
      babel: {
        plugins: [
          'react-dev-locator',
        ],
      },
    }),
    traeBadgePlugin({
      variant: 'dark',
      position: 'bottom-right',
      prodOnly: true,
      clickable: true,
      clickUrl: 'https://www.trae.ai/solo?showJoin=1',
      autoTheme: true,
      autoThemeTarget: '#root'
    }), 
    tsconfigPaths(),
    localSavePlugin()
  ],
})
