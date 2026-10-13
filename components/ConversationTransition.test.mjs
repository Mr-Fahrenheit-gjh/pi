import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { jsx: { runtime: 'automatic' } });
const { ConversationTransition } = await jiti.import('./ConversationTransition.tsx');

function mount(t, reduced = false) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldWindow = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: reduced }) };
  t.after(() => { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; });
  const view = new ConversationTransition({ transitionKey: 'a', children: 'A' });
  view.setState = patch => {
    view.state = { ...view.state, ...patch };
    view.state = { ...view.state, ...ConversationTransition.getDerivedStateFromProps(view.props, view.state) };
    view.componentDidUpdate();
  };
  const update = (key, children) => {
    view.props = { transitionKey: key, children };
    view.state = { ...view.state, ...ConversationTransition.getDerivedStateFromProps(view.props, view.state) };
    view.componentDidUpdate();
  };
  t.after(() => view.componentWillUnmount());
  return { view, update };
}

test('same-key updates stay current with no exit or remount', t => {
  const { view, update } = mount(t);
  update('a', 'A streamed');
  assert.equal(view.state.displayedChildren, 'A streamed');
  assert.equal(view.render().props.inert, false);
  t.mock.timers.tick(100);
  assert.equal(view.state.displayedKey, 'a');
});

test('exit is inert and rapid clicks commit only the latest target after 80ms', t => {
  const { view, update } = mount(t);
  update('b', 'B');
  assert.equal(view.render().props.inert, true);
  assert.equal(view.state.displayedChildren, 'A');
  t.mock.timers.tick(20);
  update('c', 'C');
  t.mock.timers.tick(59);
  assert.equal(view.state.displayedKey, 'a');
  t.mock.timers.tick(1);
  assert.equal(view.state.displayedKey, 'c');
  assert.equal(view.state.displayedChildren, 'C');
  assert.equal(view.render().props.inert, false);
});

test('returning to the displayed view cancels a pending exit', t => {
  const { view, update } = mount(t);
  update('b', 'B');
  update('a', 'A latest');
  t.mock.timers.tick(200);
  assert.equal(view.state.displayedKey, 'a');
  assert.equal(view.state.displayedChildren, 'A latest');
});

test('reduced motion swaps synchronously without the exit delay', t => {
  const { view, update } = mount(t, true);
  update('b', 'B');
  assert.equal(view.state.displayedKey, 'b');
  assert.equal(view.render().props.inert, false);
});

test('unmount cancels the pending change', t => {
  const { view, update } = mount(t);
  update('b', 'B');
  view.componentWillUnmount();
  t.mock.timers.tick(200);
  assert.equal(view.state.displayedKey, 'a');
});
