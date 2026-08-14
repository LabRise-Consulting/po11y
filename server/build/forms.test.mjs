import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildForms } from './forms.mjs';

const core = JSON.parse(
  readFileSync(new URL('./__fixtures__/core-workflows.json', import.meta.url), 'utf8'),
);

test('core fixture yields the two form triggers with title/description', () => {
  const { forms } = buildForms(core);
  assert.equal(forms.length, 2);
  assert.deepEqual(forms, [
    {
      name: 'Refresh status now',
      sub: 'Re-poll containers and republish status.json immediately.',
      path: 'status-refresh',
      fields: 0,
    },
    {
      name: 'Build maps now',
      sub: 'Re-export all workflows and rebuild the Map, Actions and Architecture (AI) feeds immediately.',
      path: 'maps-build-now',
      fields: 0,
    },
  ]);
});

test('inactive workflows are excluded', () => {
  const wfs = [
    {
      id: 'idle',
      name: 'Idle',
      active: false,
      isArchived: false,
      nodes: [
        { name: 'ft', type: 'n8n-nodes-base.formTrigger', parameters: { path: 'idle-form' } },
      ],
    },
  ];
  assert.deepEqual(buildForms(wfs), { forms: [] });
});

test('archived workflows are excluded', () => {
  const wfs = [
    {
      id: 'arch',
      name: 'Arch',
      active: true,
      isArchived: true,
      nodes: [
        { name: 'ft', type: 'n8n-nodes-base.formTrigger', parameters: { path: 'arch-form' } },
      ],
    },
  ];
  assert.deepEqual(buildForms(wfs), { forms: [] });
});

test('path falls back to webhookId; missing both is skipped', () => {
  const wfs = [
    {
      id: 'wf',
      name: 'WF',
      active: true,
      isArchived: false,
      nodes: [
        { name: 'byWebhook', type: 'n8n-nodes-base.formTrigger', parameters: {}, webhookId: 'hooked' },
        { name: 'noPath', type: 'n8n-nodes-base.formTrigger', parameters: {} },
      ],
    },
  ];
  const { forms } = buildForms(wfs);
  assert.equal(forms.length, 1);
  assert.equal(forms[0].path, 'hooked');
});

test('name falls back to node name, sub falls back to workflow name', () => {
  const wfs = [
    {
      id: 'wf',
      name: 'Workflow Name',
      active: true,
      isArchived: false,
      nodes: [
        { name: 'Node Name', type: 'n8n-nodes-base.formTrigger', parameters: { path: 'p' } },
      ],
    },
  ];
  const { forms } = buildForms(wfs);
  assert.equal(forms[0].name, 'Node Name');
  assert.equal(forms[0].sub, 'Workflow Name');
});

test('fields counts formFields.values length', () => {
  const wfs = [
    {
      id: 'wf',
      name: 'WF',
      active: true,
      isArchived: false,
      nodes: [
        {
          name: 'ft',
          type: 'n8n-nodes-base.formTrigger',
          parameters: {
            path: 'p',
            formFields: { values: [{ fieldLabel: 'a' }, { fieldLabel: 'b' }, { fieldLabel: 'c' }] },
          },
        },
      ],
    },
  ];
  assert.equal(buildForms(wfs).forms[0].fields, 3);
});
