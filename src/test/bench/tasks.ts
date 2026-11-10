export interface Operation {
  tool: string;
  name?: string;
  to?: string;
  input?: Record<string, unknown>;
}
export interface BenchTask {
  id: string;
  kind: string;
  instruction: string;
  value: string;
  operations: Operation[];
  trusted?: boolean;
}
const kinds = [
  'plain',
  'wizard',
  'controlled',
  'date',
  'autocomplete',
  'modal',
  'table',
  'frame',
  'shadow',
  'upload',
  'drag',
  'signin',
] as const;
export const tasks: BenchTask[] = kinds.flatMap((kind) =>
  [1, 2, 3].map((variant) => {
    const value = kind === 'date' ? `2027-02-0${variant}` : `Entry ${variant}`;
    const operations: Operation[] = [];
    const click = (name: string) =>
      operations.push({ tool: 'browser_click', name });
    const type = (name: string) =>
      operations.push({ tool: 'browser_type', name, input: { text: value } });
    if (kind === 'wizard') click('Begin entry');
    if (kind === 'modal') click('Open dialog');
    if (kind === 'signin') click('Sign in to continue');
    if (
      ['plain', 'wizard', 'controlled', 'modal', 'frame', 'signin'].includes(
        kind,
      )
    ) {
      type('Customer name');
      click('Save entry');
    }
    if (kind === 'date') {
      type('Appointment date');
      click('Confirm date');
    }
    if (kind === 'autocomplete') {
      type('City');
      click(value);
    }
    if (kind === 'table') {
      type('Matching code');
      click('Confirm code');
    }
    if (kind === 'shadow') click('Confirm shadow');
    if (kind === 'upload') {
      operations.push({
        tool: 'browser_upload',
        name: 'Upload file',
        input: { fileId: 'BENCH_ATTACHMENT' },
      });
      click('Check upload');
    }
    if (kind === 'drag')
      operations.push({
        tool: 'browser_drag',
        name: 'Drag item',
        to: 'Drop zone',
      });
    return {
      id: `${kind}-${variant}`,
      kind,
      value,
      operations,
      instruction:
        kind === 'upload'
          ? 'Upload the attached text file and click Check upload.'
          : kind === 'shadow'
            ? 'Click Confirm shadow.'
            : kind === 'drag'
              ? 'Drag Drag item onto Drop zone.'
              : kind === 'date'
                ? `Set Appointment date to ${value} and confirm it.`
                : kind === 'autocomplete'
                  ? `Choose ${value} from the city suggestions.`
                  : kind === 'table'
                    ? 'Read the table, enter the code in Matching code, then confirm it.'
                    : `Enter ${value} as the customer name and save the entry.${kind === 'wizard' ? ' Begin the entry first.' : kind === 'modal' ? ' Open the dialog first.' : kind === 'signin' ? ' Use Sign in to continue first.' : ''}`,
    };
  }),
);
// Trusted-event checks are reported separately from the 36 core workflow tasks.
export const trustedTask: BenchTask = {
  id: 'trusted-input',
  kind: 'trusted',
  value: 'Trusted input',
  trusted: true,
  instruction:
    'Type Trusted input as the customer name, then click Confirm trusted input.',
  operations: [
    {
      tool: 'browser_type',
      name: 'Customer name',
      input: { text: 'Trusted input' },
    },
    { tool: 'browser_click', name: 'Confirm trusted input' },
  ],
};
