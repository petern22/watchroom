// The desktop overlay page: plays one effect once, over everything on this screen.
import { glowPulse, heartBurst } from './extras.js';

if (new URLSearchParams(location.search).get('kind') === 'glow') glowPulse();
else heartBurst();
