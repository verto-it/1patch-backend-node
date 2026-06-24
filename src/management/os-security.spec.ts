import { isWorldWritableMode, memoryPressureFromValues } from './management.service';

describe('OS security permission checks', () => {
  it('does not treat normal passwd permissions as world-writable', () => {
    expect(isWorldWritableMode('644')).toBe(false);
    expect(isWorldWritableMode('0644')).toBe(false);
    expect(isWorldWritableMode('640')).toBe(false);
    expect(isWorldWritableMode('444')).toBe(false);
  });

  it('detects the world write permission bit', () => {
    expect(isWorldWritableMode('646')).toBe(true);
    expect(isWorldWritableMode('666')).toBe(true);
    expect(isWorldWritableMode('777')).toBe(true);
    expect(isWorldWritableMode('100666')).toBe(true);
  });

  it('ignores invalid stat output', () => {
    expect(isWorldWritableMode('')).toBe(false);
    expect(isWorldWritableMode('not-a-mode')).toBe(false);
  });
});

describe('memory pressure collection', () => {
  it('uses container memory when cgroup usage is available', () => {
    expect(memoryPressureFromValues(128, 512, 1024, 768)).toEqual({
      pressurePercent: 25,
      message: 'container memory 128 B / 512 B',
    });
  });

  it('uses Docker-visible host memory as the limit when the container has no explicit cap', () => {
    expect(memoryPressureFromValues(128, undefined, 1024, 768)).toEqual({
      pressurePercent: 12.5,
      message: 'container memory 128 B / 1.0 KiB',
    });
  });

  it('uses system memory when no container usage is available', () => {
    expect(memoryPressureFromValues(undefined, undefined, 1024, 768)).toEqual({
      pressurePercent: 25,
      message: 'system memory 256 B / 1.0 KiB',
    });
  });
});
