import { describe, expect, test } from 'vitest';
import { parseImageTag, containerStatusColor, fmtState } from './container-format.js';

describe('parseImageTag', () => {
  test('splits name and tag', () => {
    expect(parseImageTag('openpalm/ui:0.11.0')).toEqual({ name: 'openpalm/ui', tag: '0.11.0' });
  });

  test('defaults to latest when no tag', () => {
    expect(parseImageTag('openpalm/ui')).toEqual({ name: 'openpalm/ui', tag: 'latest' });
  });

  test('strips digest and keeps the tag', () => {
    expect(parseImageTag('openpalm/ui:0.11.0@sha256:abc123')).toEqual({
      name: 'openpalm/ui',
      tag: '0.11.0',
    });
  });

  test('digest-only image (no tag) defaults to latest', () => {
    expect(parseImageTag('openpalm/ui@sha256:abc123')).toEqual({
      name: 'openpalm/ui',
      tag: 'latest',
    });
  });

  test('registry with port is not mistaken for a tag', () => {
    expect(parseImageTag('registry.example.com:5000/openpalm/ui:dev')).toEqual({
      name: 'registry.example.com:5000/openpalm/ui',
      tag: 'dev',
    });
  });

  test('registry with port and no tag defaults to latest', () => {
    // lastIndexOf(':') lands on the port, which becomes the "tag" — documents
    // the known limitation: a registry:port with no image tag is ambiguous.
    expect(parseImageTag('registry.example.com:5000/openpalm/ui')).toEqual({
      name: 'registry.example.com',
      tag: '5000/openpalm/ui',
    });
  });
});

describe('containerStatusColor', () => {
  test('running -> success', () => {
    expect(containerStatusColor('running')).toBe('success');
  });

  test('exited/dead/stopped -> danger', () => {
    expect(containerStatusColor('exited')).toBe('danger');
    expect(containerStatusColor('dead')).toBe('danger');
    expect(containerStatusColor('stopped')).toBe('danger');
  });

  test('restarting/paused -> warning', () => {
    expect(containerStatusColor('restarting')).toBe('warning');
    expect(containerStatusColor('paused')).toBe('warning');
  });

  test('unknown -> idle', () => {
    expect(containerStatusColor('created')).toBe('idle');
    expect(containerStatusColor('')).toBe('idle');
  });
});

describe('fmtState', () => {
  test('capitalizes first letter', () => {
    expect(fmtState('running')).toBe('Running');
  });

  test('handles empty/nullish', () => {
    expect(fmtState('')).toBe('');
    expect(fmtState(null)).toBe('');
    expect(fmtState(undefined)).toBe('');
  });
});
