// A hosted endpoint that speaks the OpenAI Images protocol: the project's own
// cloud service, or any compatible gateway. Needs a base URL as well as a key:
//   tintloom config set cloud-url https://example.com/v1
import { UserError } from '../lib/util.mjs';
import { makeOpenAICompatible } from './openai.mjs';

export default makeOpenAICompatible({
  id: 'cloud',
  label: 'Cloud (OpenAI-compatible endpoint)',
  envKeys: ['TINTLOOM_CLOUD_KEY'],
  defaultModel: 'auto',
  models: ['auto'],
  baseUrl: (ctx) => {
    const url = ctx.setting('cloud-url');
    if (!url) {
      throw new UserError('The cloud provider has no endpoint set.', 'Run: tintloom config set cloud-url https://your-endpoint/v1');
    }
    return url;
  },
  notes: 'One key for many models through a hosted endpoint. Set cloud-url first.',
});
