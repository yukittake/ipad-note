import { requireOptionalNativeModule } from 'expo-modules-core';

export type RememberedDirectory = { savedUri: string; uri: string };

type PersistentDirectoryModule = {
  pickDirectory(): Promise<string | null>;
  restoreDirectories(): Promise<RememberedDirectory[]>;
  forgetDirectory(uri: string): Promise<void>;
};

export default requireOptionalNativeModule<PersistentDirectoryModule>('PersistentDirectory');
