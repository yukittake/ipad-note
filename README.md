# iPad Note

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [release build](https://reactnative.dev/docs/publishing-to-app-store)
- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

`src/app` contains route entries. Screen components, hooks, constants, and shared state live under `src/attachments/routes/<route>`; file storage lives in `src/infra/local`.

## Code checks

```bash
npm run lint
npm run typecheck
npm run format:check
```

Run `npm run format` to apply Prettier formatting.