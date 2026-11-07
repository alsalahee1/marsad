import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  buildLocation,
  destinationForPath,
  parseLocation,
  useRoute,
} from '../src/shell/navigation.js';

describe('routes', () => {
  it('parses destinations and focus params, rejecting junk', () => {
    expect(parseLocation('/agents', '?agent=abc-1')).toEqual({
      dest: 'agents',
      focus: { run: null, agent: 'abc-1', approval: null },
    });
    expect(parseLocation('/log/', '?run=9b2d&junk=1').focus).toEqual({
      run: '9b2d',
      agent: null,
      approval: null,
    });
    expect(parseLocation('/nowhere', '?run=<script>').focus.run).toBeNull();
    expect(parseLocation('/nowhere', '').dest).toBe('desk');
    expect(destinationForPath('/approvals')).toBe('approvals');
  });

  it('round-trips through buildLocation', () => {
    const route = parseLocation('/approvals', '?approval=a1&run=r1');
    expect(buildLocation(route)).toBe('/approvals?run=r1&approval=a1');
    expect(buildLocation({ dest: 'desk', focus: { run: null, agent: null, approval: null } })).toBe(
      '/',
    );
  });
});

describe('useRoute', () => {
  it('navigates, opens details on the live destination, and closes them', () => {
    window.history.replaceState(null, '', '/');
    const { result } = renderHook(() => useRoute());
    expect(result.current.dest).toBe('desk');
    act(() => {
      // One handler, two pushes: the second must see the first.
      result.current.navigate('agents');
      result.current.setFocus({ agent: 'a1' });
    });
    expect(window.location.pathname + window.location.search).toBe('/agents?agent=a1');
    expect(result.current).toMatchObject({ dest: 'agents', focus: { agent: 'a1', run: null } });
    act(() => {
      result.current.setFocus({ run: 'r1' });
    });
    expect(window.location.search).toBe('?run=r1&agent=a1');
    act(() => {
      result.current.setFocus({ run: null });
    });
    expect(window.location.search).toBe('?agent=a1');
    act(() => {
      result.current.navigate('log');
    });
    expect(window.location.pathname + window.location.search).toBe('/log');
  });
});
