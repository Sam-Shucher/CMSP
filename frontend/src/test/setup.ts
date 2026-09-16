import '@testing-library/jest-dom';

// jsdom doesn't implement createObjectURL — stub it so components that
// preview a selected image (via URL.createObjectURL) don't crash in tests.
if (!URL.createObjectURL) {
  URL.createObjectURL = (): string => 'blob:mock-preview-url';
}
