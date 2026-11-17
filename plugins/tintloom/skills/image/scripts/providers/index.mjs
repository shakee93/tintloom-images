// The provider registry. To add a provider: write one file that exports
// { id, label, envKeys, defaultModel, models, notes, capabilities, generate },
// then add it to this list. See CONTRIBUTING.md.
import cloud from './cloud.mjs';
import fal from './fal.mjs';
import gemini from './gemini.mjs';
import modelark from './modelark.mjs';
import openai from './openai.mjs';

// Order is the fallback order when no default provider is set.
export const providers = [openai, gemini, fal, modelark, cloud];

export const getProvider = (id) => providers.find((p) => p.id === id) || null;
