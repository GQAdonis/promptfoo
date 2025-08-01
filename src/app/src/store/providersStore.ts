import { create } from 'zustand';
import type { ProviderOptions } from '@promptfoo/types';

interface ProvidersState {
  customProviders: ProviderOptions[];
  addCustomProvider: (provider: ProviderOptions) => void;
  removeCustomProvider: (providerId: string) => void;
}

export const useProvidersStore = create<ProvidersState>((set) => ({
  customProviders: [],
  addCustomProvider: (provider) =>
    set((state) => ({
      customProviders: [...state.customProviders, provider],
    })),
  removeCustomProvider: (providerId) =>
    set((state) => ({
      customProviders: state.customProviders.filter((p) => p.id !== providerId),
    })),
}));
