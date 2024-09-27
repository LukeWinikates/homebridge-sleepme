/**
 * For a detailed explanation regarding each configuration property, visit:
 * https://jestjs.io/docs/configuration
 */

import type {Config} from 'jest';

const config: Config = {
  // Stop running tests after `n` failures
  // bail: 0,

  // The directory where Jest should store its cached dependency information
  // cacheDirectory: "/private/var/folders/42/08tmzklx4yq4198c6q8rlb580000gn/T/jest_dx",

  // Automatically clear mock calls, instances, contexts and results before every test
  clearMocks: true,

  // A path to a custom dependency extractor
  // dependencyExtractor: undefined,
  errorOnDeprecated: true,

  // An array of file extensions your modules use
  moduleFileExtensions: [
    "js",
    "mjs",
    "cjs",
    // "jsx",
    "ts",
    // "tsx",
    // "json",
    // "node"
  ],
  resolver: "ts-jest-resolver",
};

export default config;
