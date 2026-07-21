import { allowMethods, db, estimateChatCharge, fetchWithTimeout, getAvailableModels, getTrialModelId, json, localize, MARKUP, PACKAGES, packageQuote, requestLocale, requireUser, TOKEN_USD } from './_lib.js';

const IMAGE_PROVIDER_ORDER = ['x-ai', 'openai', 'google', 'bytedance-seed', 'black-forest-labs', 'stability-ai', 'recraft', 'ideogram'];
const IMAGE_PROVIDER_LABELS = { 'x-ai':'xAI · Grok Imagine',
  openai: 'OpenAI · GPT Image',
  google: 'Google · Gemini / Imagen',
  'bytedance-seed': 'ByteDance · Seedream',
  'black-forest-labs': 'Black Forest Labs · FLUX',
  'stability-ai': 'Stability AI',
  recraft: 'Recraft',
  ideogram: 'Ideogram'
};
let imageCatalogCache = { at: 0, models: [] };

function chatCostPerMillion(model = {}) {
  const prompt = Number(model.pricing?.prompt);
  const completion = Number(model.pricing?.completion);
  const hasPrompt = Number.isFinite(prompt) && prompt >= 0;
  const hasCompletion = Number.isFinite(completion) && completion >= 0;
  if (!hasPrompt && !hasCompletion) return Number.POSITIVE_INFINITY;
  return (hasPrompt ? prompt : 0) * 1000000 + (hasCompletion ? completion : 0) * 1000000;
}

function compareChatCostAsc(a, b) {
  const aCost = chatCostPerMillion(a);
  const bCost = chatCostPerMillion(b);
  if (aCost !== bCost) {
    if (!Number.isFinite(aCost)) return 1;
    if (!Number.isFinite(bCost)) return -1;
    return aCost - bCost;
  }
  return String(a.name || a.id).localeCompare(String(b.name || b.id));
}

function compareChatCostDesc(a, b) {
  const aCost = chatCostPerMillion(a);
  const bCost = chatCostPerMillion(b);
  if (aCost !== bCost) {
    if (!Number.isFinite(aCost)) return 1;
    if (!Number.isFinite(bCost)) return -1;
    return bCost - aCost;
  }
  return String(a.name || a.id).localeCompare(String(b.name || b.id));
}

function imageUnitCost(model = {}) {
  const values = [model.pricing?.image, model.pricing?.image_output, model.pricing?.request]
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(Number)
    .filter(value => Number.isFinite(value) && value >= 0);
  return values.length ? Math.min(...values) : Number.POSITIVE_INFINITY;
}

function isUnsupportedOpenRouterImageModel(model = {}) {
  const id = String(model.id || '').toLowerCase();
  const name = String(model.name || '').toLowerCase();
  return id === 'openrouter/auto' || id === 'openrouter/auto:beta' || id === 'openrouter/auto-beta'
    || /(^|\/)openrouter[\s:_-]*(auto)?[\s:_-]*beta$/.test(id)
    || /^openrouter(?:\s+auto)?(?:\s+beta)?$/.test(name.trim());
}

function compareImageCostAsc(a, b) {
  const costDifference = imageUnitCost(a) - imageUnitCost(b);
  if (Number.isFinite(costDifference) && costDifference !== 0) return costDifference;
  if (imageUnitCost(a) !== imageUnitCost(b)) return imageUnitCost(a) === Number.POSITIVE_INFINITY ? 1 : -1;
  return String(a.name || a.id).localeCompare(String(b.name || b.id));
}

function imageProvider(id = '') {
  const prefix = String(id).split('/')[0].toLowerCase();
  if (prefix === 'openai') return 'openai';
  if (prefix === 'google') return 'google';
  if (['bytedance-seed', 'bytedance'].includes(prefix) || /seedream/i.test(id)) return 'bytedance-seed';
  if (['black-forest-labs', 'black-forest'].includes(prefix) || /flux/i.test(id)) return 'black-forest-labs';
  if (prefix.includes('stability')) return 'stability-ai';
  if (prefix === 'recraft') return 'recraft';
  if (prefix === 'ideogram') return 'ideogram';
  return prefix || 'other';
}

function enumValues(descriptor) {
  if (Array.isArray(descriptor)) return descriptor.map(String);
  if (descriptor?.type === 'enum' && Array.isArray(descriptor.values)) return descriptor.values.map(String);
  return [];
}

function serializableCapabilities(supported = {}) {
  const result = {};
  for (const [key, descriptor] of Object.entries(supported || {})) {
    if (Array.isArray(descriptor)) result[key] = { type: 'enum', values: descriptor.map(String) };
    else if (descriptor && typeof descriptor === 'object') result[key] = descriptor;
    else if (descriptor === true) result[key] = { type: 'boolean' };
  }
  return result;
}

function shortImageName(model) {
  return String(model.name || model.id || '')
    .replace(/^(OpenAI|Google|ByteDance|Black Forest Labs|Stability AI|Recraft|Ideogram)[:\\s-]+/i, '')
    .replace(/\\s+(Preview|Experimental)$/i, '')
    .trim();
}

async function getImageModels() {
  if (imageCatalogCache.models.length && Date.now() - imageCatalogCache.at < 60 * 60 * 1000) return imageCatalogCache.models;
  try {
    const r = await fetchWithTimeout('https://openrouter.ai/api/v1/images/models', {
      headers: process.env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {}
    }, 15000);
    if (!r.ok) throw new Error(`OpenRouter image models ${r.status}`);
    const payload = await r.json();
    const groups = new Map();
    for (const model of payload.data || []) {
      if (!model?.id || !model.architecture?.output_modalities?.includes('image') || isUnsupportedOpenRouterImageModel(model)) continue;
      const provider = imageProvider(model.id);
      if (!groups.has(provider)) groups.set(provider, []);
      groups.get(provider).push(model);
    }
    const providers = [...IMAGE_PROVIDER_ORDER, ...[...groups.keys()].filter(x => !IMAGE_PROVIDER_ORDER.includes(x)).sort()];
    const selected = [];
    const selectedIds = new Set();
    const addModel = (model, provider) => {
      if (!model?.id || selectedIds.has(model.id)) return;
      selectedIds.add(model.id);
      selected.push({
        id: model.id,
        name: model.name || model.id,
        shortName: shortImageName(model),
        type: 'image',
        provider,
        providerLabel: IMAGE_PROVIDER_LABELS[provider] || provider,
        created: Number(model.created || 0),
        description: model.description || '',
        pricing: model.pricing || {},
        supportedParameters: serializableCapabilities(model.supported_parameters),
        supportedAspectRatios: enumValues(model.supported_parameters?.aspect_ratio),
        supportedResolutions: enumValues(model.supported_parameters?.resolution)
      });
    };

    for (const provider of providers) {
      const providerModels = (groups.get(provider) || [])
        .sort((a, b) => Number(b.created || 0) - Number(a.created || 0) || String(a.name || a.id).localeCompare(String(b.name || b.id)));

      // Keep the newest three Seedream image models explicitly in the image list.
      // This prevents them from being displaced by other ByteDance image models.
      if (provider === 'bytedance-seed') {
        providerModels.filter(model => /seedream/i.test(`${model.id} ${model.name || ''}`)).slice(0, 3)
          .forEach(model => addModel(model, provider));
        providerModels.filter(model => !/seedream/i.test(`${model.id} ${model.name || ''}`)).slice(0, 3)
          .forEach(model => addModel(model, provider));
        continue;
      }

      providerModels.slice(0, 3).forEach(model => addModel(model, provider));
    }
    const sortedByPrice = selected.filter(model => !isUnsupportedOpenRouterImageModel(model)).sort(compareImageCostAsc);
    imageCatalogCache = { at: Date.now(), models: sortedByPrice };
    return sortedByPrice;
  } catch (error) {
    console.warn('Unable to load image model catalog:', error.message);
    return imageCatalogCache.models;
  }
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET', 'POST'])) return;
  const locale = requestLocale(req);
  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (body.action !== 'estimate-message') return json(res, 400, { error: localize(locale, 'طلب غير صالح.', 'Invalid request.'), code: 'INVALID_ACTION' });
      const modelId = String(body.modelId || '').trim();
      if (!modelId) return json(res, 400, { error: localize(locale, 'اختر نموذجًا أولًا.', 'Choose a model first.'), code: 'MODEL_REQUIRED' });
      const [catalog, imageCatalog] = await Promise.all([getAvailableModels(), getImageModels()]);
      const chatModel = catalog.find(model => model.id === modelId);
      const imageModel = imageCatalog.find(model => model.id === modelId);
      if (!chatModel && !imageModel) return json(res, 404, { error: localize(locale, 'النموذج غير متاح حاليًا.', 'The model is currently unavailable.'), code: 'MODEL_UNAVAILABLE' });
      if (imageModel) {
        const values = [imageModel.pricing?.request, imageModel.pricing?.image, imageModel.pricing?.image_output]
          .map(Number).filter(value => Number.isFinite(value) && value >= 0);
        const baseUsd = values.length ? values[0] : 0.04;
        const resolution = String(body.resolution || '').toLowerCase();
        const resolutionMultiplier = /2048|2k|4k|hd/.test(resolution) ? 1.65 : /1024|1k|medium/.test(resolution) ? 1.2 : 1;
        const referenceMultiplier = body.hasReferenceImage ? 1.12 : 1;
        const providerUsd = baseUsd * resolutionMultiplier * referenceMultiplier;
        return json(res, 200, {
          type: 'image', modelId, modelName: imageModel.shortName || imageModel.name || modelId,
          providerUsd, baseUsd, resolution, resolutionMultiplier, referenceImage: Boolean(body.hasReferenceImage),
          chargedTokens: Math.max(1, Math.ceil(providerUsd / TOKEN_USD)), approximate: true
        });
      }
      const messages = Array.isArray(body.messages) ? body.messages.slice(-50) : [];
      const estimate = estimateChatCharge(chatModel.pricing || {}, messages, Boolean(body.webSearch), Number(body.outputReserve || 0));
      return json(res, 200, { type: 'chat', modelId, modelName: chatModel.name || modelId, ...estimate, approximate: true });
    }
    let unlocked = false;
    try {
      const user = await requireUser(req);
      const { data } = await db().from('users').select('has_purchased').eq('id', user.id).single();
      unlocked = Boolean(data?.has_purchased);
    } catch {}

    const [catalog, imageCatalog, trialModelId] = await Promise.all([getAvailableModels(), getImageModels(), getTrialModelId()]);
    const normalizedModels = catalog.map(model => ({
      id: model.id,
      name: model.name,
      family: model.family,
      familyLabel: model.familyLabel,
      tag: model.tag,
      description: model.description,
      contextLength: model.contextLength,
      created: model.created,
      type: 'chat',
      isFree: Boolean(model.isFree),
      pricing: model.pricing || { prompt: null, completion: null },
      shortName: model.name,
      provider: model.family,
      providerLabel: model.familyLabel,
      locked: !unlocked && model.id !== trialModelId && !model.isFree,
      trial: model.id === trialModelId,
      costPerMillion: chatCostPerMillion(model)
    }));
    const models = [...normalizedModels].sort(compareChatCostAsc);
    const paidChatModels = normalizedModels.filter(model => !model.isFree);
    const chatModelOrders = {
      cheapest: [...paidChatModels].sort(compareChatCostAsc).map(model => model.id),
      mostExpensive: [...paidChatModels].sort(compareChatCostDesc).map(model => model.id),
      free: normalizedModels.filter(model => model.isFree).sort(compareChatCostAsc).map(model => model.id)
    };

    const packages = {};
    try {
      for (const id of Object.keys(PACKAGES)) packages[id] = await packageQuote(id);
    } catch {
      for (const [id, pack] of Object.entries(PACKAGES)) packages[id] = { ...pack, amountPi: null };
    }

    return json(res, 200, {
      name: 'AiWay',
      models,
      chatModelOrders,
      trialModelId,
      packages,
      imageModels: imageCatalog.map(model => {
        const pricingValues = [model.pricing?.image, model.pricing?.image_output, model.pricing?.request]
          .filter(value => value !== undefined && value !== null && value !== '')
          .map(Number)
          .filter(Number.isFinite);
        const explicitlyFree = pricingValues.length > 0 && pricingValues.every(value => value === 0);
        return { ...model, isFree: explicitlyFree, locked: !unlocked && !explicitlyFree };
      }),
      tokenUsd: TOKEN_USD,
      refreshedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: localize(locale, 'تعذر تحميل النماذج والأسعار حاليًا. حاول تحديث الصفحة.', 'Could not load models and pricing right now. Refresh the page and try again.'), code: 'SERVER_ERROR' });
  }
}
