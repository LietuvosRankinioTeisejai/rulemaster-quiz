const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync('index.html', 'utf8');
const scriptMatches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
const appScript = scriptMatches[scriptMatches.length - 1][1];
const requiredRules = [2, 4, 6, 7, 8, 13, 14, 15, 16];

function createSeededCrypto(seed) {
  let state = seed >>> 0;
  return {
    getRandomValues(values) {
      for (let index = 0; index < values.length; index += 1) {
        state = ((state * 1664525) + 1013904223) >>> 0;
        values[index] = state;
      }
      return values;
    }
  };
}

function makeContext(seed = 0x13579bdf) {
  const noop = () => {};
  const makeClassList = () => ({ add: noop, remove: noop, toggle: noop, contains: () => true });
  const makeElement = () => ({
    classList: makeClassList(),
    value: '',
    textContent: '',
    innerHTML: '',
    placeholder: '',
    appendChild: noop,
    scrollIntoView: noop
  });
  const context = {
    console,
    crypto: createSeededCrypto(seed),
    localStorage: { getItem: () => 'en', setItem: noop },
    document: {
      documentElement: {},
      getElementById: makeElement,
      createElement: makeElement,
      addEventListener: noop,
      hidden: false
    },
    window: { addEventListener: noop, scrollTo: noop, print: noop },
    fetch: async () => ({ ok: false }),
    alert: noop,
    confirm: () => true,
    setInterval,
    clearInterval,
    setTimeout,
    Date
  };
  vm.createContext(context);
  vm.runInContext(appScript, context);
  return context;
}

function evaluate(context, source) {
  return vm.runInContext(source, context);
}

function setQuestionBank(context, bank) {
  context.__QUESTION_BANK__ = bank;
  evaluate(context, 'questionBank = __QUESTION_BANK__');
}

function auditThirty(context) {
  return JSON.parse(evaluate(context, `JSON.stringify((() => {
    const audit = buildThirtyQuestionSet();
    const requiredKeys = new Set(audit.requiredQuestions.map(getQuestionKey));
    return {
      requiredRules: audit.requiredQuestions.map(getRuleNumber),
      requiredScores: audit.requiredQuestions.map(getQuestionComplexityScore),
      requiredLength: audit.requiredQuestions.length,
      additionalLength: audit.additionalQuestions.length,
      difficultAdditional: audit.additionalQuestions.filter(q => isDifficultOrLong(q, audit.difficultyThreshold)).length,
      sarAdditional: audit.additionalQuestions.filter(isSarQuestion).length,
      keys: audit.questions.map(getQuestionKey),
      orderedIds: audit.questions.map(q => q.id),
      requiredPositions: audit.questions.map((q, index) => requiredKeys.has(getQuestionKey(q)) ? index : -1).filter(index => index >= 0)
    };
  })())`));
}

function auditHundred(context) {
  return JSON.parse(evaluate(context, `JSON.stringify((() => {
    const audit = buildExtremeQuestionSet();
    const categoryCounts = {};
    audit.questions.forEach(question => {
      const category = getQuestionCategory(question);
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    });
    return {
      total: audit.questions.length,
      difficult: audit.questions.filter(q => isDifficultOrLong(q, audit.difficultyThreshold)).length,
      sarCount: audit.questions.filter(isSarQuestion).length,
      categoryCap: audit.categoryCap,
      categoryCounts,
      keys: audit.questions.map(getQuestionKey),
      orderedIds: audit.questions.map(q => q.id)
    };
  })())`));
}

function testAnswerShuffling(context, bank) {
  const source = bank.find(question => Array.isArray(question.correct) && question.correct.length > 1 && question.options.length >= 4);
  assert(source, 'A multiple-answer question is required for this test.');
  context.__SOURCE_QUESTION__ = source;

  const audit = JSON.parse(evaluate(context, `JSON.stringify((() => {
    const original = __SOURCE_QUESTION__;
    const before = JSON.stringify(original);
    const shuffled = shuffleQuestionAnswers(original);
    return { before, afterOriginal: JSON.stringify(original), isClone: shuffled !== original, shuffled };
  })())`));

  assert.strictEqual(audit.before, audit.afterOriginal, 'The original question was mutated.');
  assert(audit.isClone, 'The shuffled question must be a clone.');
  assert.deepStrictEqual(
    [...audit.shuffled.options].sort(),
    source.options.map(option => option.replace(/^\s*[a-z]\)\s*/i, '')).sort(),
    'Shuffled options are not a permutation of the original options.'
  );

  const expectedCorrectTexts = source.correct
    .map(index => source.options[index].replace(/^\s*[a-z]\)\s*/i, ''))
    .sort();
  const actualCorrectTexts = audit.shuffled.correct
    .map(index => audit.shuffled.options[index])
    .sort();
  assert.deepStrictEqual(actualCorrectTexts, expectedCorrectTexts, 'Correct indexes were not remapped accurately.');

  const answerOrders = new Set();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    answerOrders.add(evaluate(context, 'shuffleQuestionAnswers(__SOURCE_QUESTION__).options.join("||")'));
  }
  assert(answerOrders.size > 1, 'Answer choices did not vary across attempts.');
}

function runBankTests(filename) {
  const bank = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const context = makeContext(filename.includes('-en') ? 0x13579bdf : 0x2468ace0);
  setQuestionBank(context, bank);

  const requiredPoolMeanScores = JSON.parse(evaluate(context, `JSON.stringify(Object.fromEntries(${JSON.stringify(requiredRules)}.map(rule => {
    const scores = getUniqueQuestionPool(questionBank)
      .filter(question => getRuleNumber(question) === rule)
      .map(getQuestionComplexityScore);
    return [rule, scores.reduce((sum, score) => sum + score, 0) / scores.length];
  })))`));
  const requiredSelectedScores = Object.fromEntries(requiredRules.map(rule => [rule, []]));
  const thirtySelections = new Set();
  const thirtyOrders = new Set();
  const thirtySarCounts = new Set();
  let requiredQuestionSeenAfterRequiredBlock = false;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const audit = auditThirty(context);
    assert.strictEqual(audit.requiredLength, 9);
    assert.strictEqual(audit.additionalLength, 21);
    assert.strictEqual(audit.keys.length, 30);
    assert.strictEqual(new Set(audit.keys).size, 30);
    assert.deepStrictEqual(audit.requiredRules, requiredRules);
    audit.requiredRules.forEach((rule, index) => requiredSelectedScores[rule].push(audit.requiredScores[index]));
    assert(audit.difficultAdditional >= 15);
    assert(audit.requiredPositions.some(position => position >= requiredRules.length));
    requiredQuestionSeenAfterRequiredBlock ||= audit.requiredPositions.some(position => position >= requiredRules.length);
    thirtySelections.add([...audit.keys].sort().join('\n'));
    thirtyOrders.add(audit.keys.join('\n'));
    thirtySarCounts.add(audit.sarAdditional);
  }

  assert(requiredQuestionSeenAfterRequiredBlock, 'Required questions appear confined to an initial required-rule block.');
  requiredRules.forEach(rule => {
    const selectedScores = requiredSelectedScores[rule];
    const selectedMean = selectedScores.reduce((sum, score) => sum + score, 0) / selectedScores.length;
    assert(
      selectedMean > requiredPoolMeanScores[rule],
      `Required Rule ${rule} questions are not showing a measurable difficult/long-question preference.`
    );
  });
  const ruleTwoSelectedMean = requiredSelectedScores[2].reduce((sum, score) => sum + score, 0) / requiredSelectedScores[2].length;
  assert(
    ruleTwoSelectedMean > requiredPoolMeanScores[2] * 1.15,
    'Rule 2 does not show the intended stronger preference for its longest and most complex questions.'
  );
  assert(thirtySelections.size > 1, 'The 30-question selection did not vary.');
  assert(thirtyOrders.size > 1, 'The 30-question order did not vary.');
  assert(thirtySarCounts.has(0), 'SAR questions became mandatory in the 30-question test.');
  assert([...thirtySarCounts].some(count => count > 0), 'SAR questions never participated in the 30-question test.');

  const hundredSelections = new Set();
  const hundredOrders = new Set();
  const hundredSarCounts = new Set();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const audit = auditHundred(context);
    assert.strictEqual(audit.total, 100);
    assert.strictEqual(new Set(audit.keys).size, 100);
    assert(audit.difficult >= 70);
    assert(Math.max(...Object.values(audit.categoryCounts)) <= audit.categoryCap);
    hundredSelections.add([...audit.keys].sort().join('\n'));
    hundredOrders.add(audit.keys.join('\n'));
    hundredSarCounts.add(audit.sarCount);
  }

  assert(hundredSelections.size > 1, 'The 100-question selection did not vary.');
  assert(hundredOrders.size > 1, 'The 100-question order did not vary.');
  assert(hundredSarCounts.size > 1, 'The 100-question test always selected the same SAR count.');
  assert(Math.max(...hundredSarCounts) < 10, 'SAR questions dominate the 100-question test.');

  testAnswerShuffling(context, bank);

  return {
    filename,
    thirtyUniqueSelections: thirtySelections.size,
    thirtyUniqueOrders: thirtyOrders.size,
    thirtySarCounts: [...thirtySarCounts].sort((a, b) => a - b),
    hundredUniqueSelections: hundredSelections.size,
    hundredUniqueOrders: hundredOrders.size,
    hundredSarCounts: [...hundredSarCounts].sort((a, b) => a - b)
  };
}

assert(!appScript.includes('.sort(() => Math.random() - 0.5)'), 'Prohibited random sort remains in the app.');
assert(!appScript.includes('shuffledOptions'), 'Legacy answer-order storage remains in the app.');
assert(appScript.includes('q.options.map((raw, optionIndex)'), 'Detailed reports must use the attempt-specific option order.');

const results = [runBankTests('questions-en.json'), runBankTests('questions-lt.json')];
console.log(JSON.stringify(results, null, 2));
console.log('All randomisation tests passed.');
