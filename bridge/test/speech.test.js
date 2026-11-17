import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanForSpeech, cleanInline, errorReason, extractSwitch } from '../src/speech.js';

const spoken = (t) => cleanForSpeech(t).text;

describe('cleanForSpeech', () => {
  it('keeps short plain replies as they are', () => {
    assert.equal(spoken('I fixed the timeout. Tests pass now.'), 'I fixed the timeout. Tests pass now.');
  });

  it('drops fenced code blocks and says so', () => {
    const r = cleanForSpeech('Here is the fix.\n\n```js\nconst a = 1;\n```\n\nAll done.');
    assert.equal(r.text, 'Here is the fix. All done. I left code in the notes.');
    assert.equal(r.droppedCode, true);
  });

  it('drops an unterminated fence and ~~~ fences', () => {
    assert.equal(spoken('Look:\n~~~\nx\n~~~\nOk.'), 'Look. Ok. I left code in the notes.');
    assert.equal(spoken('Done.\n```\nnever closed'), 'Done. I left code in the notes.');
  });

  it('strips headings, bold, bullets and links', () => {
    const md = '## Summary\n\n**Fixed** the [upload bug](https://github.com/x/y/issues/1).\n\n- Added a retry\n- Raised the *timeout*';
    assert.equal(spoken(md), 'Summary. Fixed the upload bug. Added a retry. The rest is in the notes.');
  });

  it('turns tables into spoken cells', () => {
    const md = '| File | Status |\n| --- | --- |\n| app.js | fixed |';
    assert.equal(spoken(md), 'File, Status. app.js, fixed.');
  });

  it('replaces URLs and shortens absolute paths', () => {
    assert.equal(
      spoken('See https://example.com/a?b=c. I changed /Users/me/code/uploader/src/upload.js and ~/notes/todo.md.'),
      'See a link. I changed upload.js and todo.md.',
    );
    assert.equal(spoken('Use `/usr/local/bin/node` here.'), 'Use node here.');
    assert.equal(spoken('Ratio is 1/2 and and/or stays.'), 'Ratio is 1/2 and and/or stays.');
  });

  it('keeps at most 3 sentences', () => {
    assert.equal(spoken('One. Two. Three. Four. Five.'), 'One. Two. Three. The rest is in the notes.');
  });

  it('keeps at most 60 words', () => {
    const long = `${'word '.repeat(40).trim()}. ${'more '.repeat(30).trim()}.`;
    const r = cleanForSpeech(long);
    assert.equal(r.truncated, true);
    assert.equal(r.text, `${'word '.repeat(40).trim()}. The rest is in the notes.`);
    const single = cleanForSpeech(`${'w '.repeat(80).trim()}.`);
    assert.equal(single.text, `${'w '.repeat(60).trim()}. The rest is in the notes.`);
  });

  it('does not split on dots inside file names', () => {
    assert.equal(spoken('I edited server.js and config.json. Done.'), 'I edited server.js and config.json. Done.');
  });

  it('strips the EARPIECE_SWITCH line and returns the path', () => {
    const r = cleanForSpeech('Found the uploader repo.\nEARPIECE_SWITCH: /Users/me/code/uploader .');
    assert.equal(r.text, 'Found the uploader repo.');
    assert.equal(r.switchPath, '/Users/me/code/uploader');
  });

  it('returns empty text when nothing is speakable', () => {
    assert.equal(spoken('EARPIECE_SWITCH: /tmp/x'), '');
    assert.equal(spoken(''), '');
  });
});

describe('extractSwitch', () => {
  it('handles backticks and inline markers', () => {
    assert.deepEqual(extractSwitch('Ok.\n`EARPIECE_SWITCH: /a/b`'), { path: '/a/b', text: 'Ok.' });
    assert.equal(extractSwitch('No switch here.').path, null);
  });
});

describe('cleanInline and errorReason', () => {
  it('cleans inline markdown', () => {
    assert.equal(cleanInline('Run **the** `npm test` in /Users/me/app/web'), 'Run the npm test in web');
    assert.equal(cleanInline('keep snake_case_names intact'), 'keep snake_case_names intact');
  });

  it('gives a short reason', () => {
    assert.equal(errorReason({ subtype: 'error_max_turns', is_error: true }), 'it ran out of turns');
    assert.equal(errorReason({ result: 'API Error: overloaded. Please retry later.', is_error: true }), 'API Error: overloaded');
    assert.equal(errorReason({ subtype: 'error_weird_thing' }), 'weird thing');
  });
});
