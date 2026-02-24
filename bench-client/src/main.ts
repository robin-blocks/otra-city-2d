import { route, startRouter } from './router.js';
import { renderLanding } from './pages/landing.js';
import { renderRun } from './pages/run.js';
import { renderMethodology } from './pages/methodology.js';
import { renderSpectator } from './pages/spectator.js';

const app = document.getElementById('app')!;

route('/', () => renderLanding(app));
route('/runs/:id', (p) => renderRun(app, p.id));
route('/spectator/:id', (p) => renderSpectator(app, p.id));
route('/methodology', () => renderMethodology(app));

startRouter();
