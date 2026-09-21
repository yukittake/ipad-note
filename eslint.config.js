const { defineConfig, globalIgnores } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  globalIgnores(['dist/*', '.expo/*', 'android/*', 'ios/*', 'modules/*']),
  expoConfig,
  {
    files: ['src/attachments/routes/**/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              importNames: [
                'useState',
                'useEffect',
                'useLayoutEffect',
                'useMemo',
                'useRef',
                'useCallback',
                'useReducer',
              ],
              message: 'Route hooks belong in the route hooks.ts file.',
            },
            {
              name: 'react-native-reanimated',
              importNames: ['useAnimatedStyle', 'useSharedValue'],
              message: 'Route hooks belong in the route hooks.ts file.',
            },
            {
              name: 'expo-router',
              importNames: ['useRouter', 'useLocalSearchParams', 'useFocusEffect'],
              message: 'Route hooks belong in the route hooks.ts file.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/attachments/routes/notes/hooks.ts'],
    rules: {
      // Gesture Handler registers callbacks during render, and Reanimated shared values are mutable by design.
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      // Switching pages intentionally clears transient editor state in an effect.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
]);
