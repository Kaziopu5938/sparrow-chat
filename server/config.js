import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');

export const DEFAULT_DATA_DIR = process.env.SPARROW_DATA_DIR || path.join(ROOT, 'data');

export const DEFAULT_SETTINGS = {
  widgetId: 'default',
  branding: {
    name: 'Sparrow',
    tagline: 'Support that actually replies',
    color: '#0f766e',
    accent: '#14b8a6',
    textOnColor: '#ffffff',
    logoText: 'S',
  },
  widget: {
    position: 'br',
    offsetX: 24,
    offsetY: 24,
    greeting: 'Hi there 👋',
    subtitle: 'We typically reply in a few minutes',
    offlineMessage: "We're offline right now. Leave a message and we'll get back to you by email.",
    minimizedText: "Let's chat — we're online",
  },
  behavior: {
    showWhenOffline: true,
    prechat: true,
    requireEmail: false,
    theme: 'light',
  },
  features: {
    rating: true,
    transcript: true,
    fileUploads: false,
    knowledgeBase: true,
    sound: true,
  },
  faq: [
    {
      question: 'How long does shipping take?',
      answer: 'Standard orders ship within 24 hours and arrive in 3-5 business days.',
    },
    {
      question: 'Can I return an item?',
      answer: 'Yes — you have 30 days from delivery. Keep the original packaging and we will email a label.',
    },
  ],
  quickReplies: [
    'Thanks for reaching out! How can I help today?',
    'Let me look that up for you.',
    "I'm sorry about that — I'll get it fixed.",
    'Is there anything else I can help with?',
  ],
};

export function loadConfig(overrides = {}) {
  return {
    port: Number(process.env.PORT || 4870),
    host: process.env.HOST || '127.0.0.1',
    dataDir: DEFAULT_DATA_DIR,
    tokenSecret: process.env.SPARROW_SECRET || '',
    adminHost: process.env.SPARROW_ADMIN_HOST || '',
    publicUrl: process.env.SPARROW_PUBLIC_URL || 'http://localhost:4870',
    seedDemo: process.env.SPARROW_SEED !== '0',
    ...overrides,
  };
}
