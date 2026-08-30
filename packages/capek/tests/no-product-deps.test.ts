import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const forbiddenSpecifiers = [
  ['@jean2', '/'].join(''),
  ['@prokopai', '/'].join(''),
];

function collectTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...collectTypeScriptFiles(path));
    } else if (path.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

function packageDependencyNames(packagePath: string): string[] {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ];
}

function isProductSpecifier(value: string): boolean {
  return forbiddenSpecifiers.some((specifier) => value.includes(specifier));
}

describe('Capek product dependency boundary', () => {
  test('Capek source and tests contain no product package specifiers', () => {
    const packages = ['capek', 'capek-types', 'capek-tool'];
    const files = packages.flatMap((name) => [
      ...collectTypeScriptFiles(resolve(repositoryRoot, `packages/${name}/src`)),
      ...collectTypeScriptFiles(resolve(repositoryRoot, `packages/${name}/tests`)),
    ]);
    const violations = files.filter((file) => isProductSpecifier(readFileSync(file, 'utf8')));
    expect(violations).toEqual([]);
  });

  test('Capek packages declare no product dependencies', () => {
    const packages = ['capek', 'capek-types', 'capek-tool'];
    const violations = packages.flatMap((name) => packageDependencyNames(
      resolve(repositoryRoot, `packages/${name}/package.json`),
    ).filter(isProductSpecifier));
    expect(violations).toEqual([]);
  });
});
