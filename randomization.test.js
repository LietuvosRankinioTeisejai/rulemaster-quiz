const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync('index.html', 'utf8');
const scriptMatches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
const appScript = scriptMatches[scriptMatches.length - 1][1];
const SEQUENTIAL_ATTEMPTS = Math.max(20, Number(process.env.RANDOMIZATION_ATTEMPTS || 250));
const HISTORY_DEPTH = 16;

function createSeededCrypto(seed) {
  let state = seed >>> 0;
  let calls = 0;
  return {
    getRandomValues(values) {
      calls += 1;
      for (let index = 0; index < values.length; index += 1) {
        state = ((state * 1664525) + 1013904223) >>> 0;
        values[index] = state;
      }
      return values;
    },
    getCallCount() {
      return calls;
    }
  };
}

function makeContext(seed = 0x13579bdf) {
  const noop = () => {};
  const storageReads = [];
  const storageWrites = [];
  const seededCrypto = createSeededCrypto(seed);
  const makeClassList = () => ({ add: noop, remove: noop, toggle: noop, contains: () => true });
  const makeElement = () => ({
    classList: makeClassList(),
    value: '',
    textContent: '',
    innerHTML: '',
    placeholder: '',
    appendChild: noop,
    setAttribute: noop,
    scrollIntoView: noop
  });
  const context = {
    console,
    crypto: seededCrypto,
    localStorage: {
      getItem(key) {
        storageReads.push(key);
        return key === 'quizLanguage' ? 'en' : null;
      },
      setItem(key, value) {
        storageWrites.push([key, value]);
      }
    },
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
  context.__storageReads = storageReads;
  context.__storageWrites = storageWrites;
  context.__seededCrypto = seededCrypto;
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

function getUniqueBank(context) {
  return context.getUniqueQuestionPool(evaluate(context, 'questionBank'));
}

function categoryCounts(context, questions) {
  const counts = new Map();
  questions.forEach(question => {
    const category = context.getQuestionCategory(question);
    counts.set(category, (counts.get(category) || 0) + 1);
  });
  return counts;
}

function categorySignature(counts) {
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, count]) => `${category}:${count}`).join('|');
}

function combinationSignature(counts) {
  return [...counts.keys()].sort().join('|');
}

function selectionSignature(context, questions) {
  return questions.map(context.getQuestionKey).sort().join('\n');
}

function orderSignature(context, questions) {
  return questions.map(context.getQuestionKey).join('\n');
}

function intersectCount(leftSet, rightSet) {
  let count = 0;
  leftSet.forEach(value => { if (rightSet.has(value)) count += 1; });
  return count;
}

function getEligiblePool(context, mode, uniqueBank) {
  if (mode === 30) return uniqueBank.filter(context.isEligibleForThirtyQuestionTest);
  return uniqueBank;
}

function assertShuffleIntegrity(context, question) {
  const originalOptions = Array.from(question.options || []);
  const originalCorrect = Array.from(question.correct || []);
  const originalText = String(question.text || '');
  const shuffled = context.shuffleQuestionAnswers(question);
  assert.notStrictEqual(shuffled, question, 'Answer shuffling must return a clone.');
  assert.strictEqual(String(question.text || ''), originalText, 'Answer shuffling mutated the source question text.');
  assert.deepStrictEqual(Array.from(question.options || []), originalOptions, 'Answer shuffling mutated source options.');
  assert.deepStrictEqual(Array.from(question.correct || []), originalCorrect, 'Answer shuffling mutated source correct indexes.');
  assert.strictEqual(shuffled.options.length, originalOptions.length, 'Shuffled option count changed.');
  const clean = text => String(text || '').replace(/^\s*[a-z]\)\s*/i, '');
  const expectedOptionTexts = originalOptions.map(clean).sort();
  const actualOptionTexts = Array.from(shuffled.options).map(String).sort();
  assert.deepStrictEqual(actualOptionTexts, expectedOptionTexts, 'Shuffled options are not a permutation of the original options.');
  const expectedCorrectTexts = originalCorrect.map(index => clean(originalOptions[index])).sort();
  const actualCorrectTexts = Array.from(shuffled.correct).map(index => shuffled.options[index]).sort();
  assert.deepStrictEqual(actualCorrectTexts, expectedCorrectTexts, 'Correct indexes were not remapped accurately after answer shuffling.');
}

function buildMode(context, mode) {
  if (mode === 30) return context.buildThirtyQuestionSet();
  if (mode === 100) return context.buildExtremeQuestionSet();
  return context.buildCategoryFirstQuestionSet(mode);
}

function verifyModeConstraints(context, mode, audit, eligiblePool) {
  const questions = audit.questions;
  assert.strictEqual(questions.length, mode, `${mode}-question mode returned the wrong count.`);
  const keys = questions.map(context.getQuestionKey);
  assert.strictEqual(new Set(keys).size, mode, `${mode}-question mode contains duplicate question keys.`);
  const counts = categoryCounts(context, questions);
  assert.strictEqual([...counts.values()].reduce((sum, value) => sum + value, 0), mode, 'Category counts do not add up to the requested total.');
  const eligibleKeys = new Set(eligiblePool.map(context.getQuestionKey));
  keys.forEach(key => assert(eligibleKeys.has(key), `${mode}-question mode selected an ineligible question.`));

  if (mode === 15) {
    assert(Math.max(...counts.values()) <= 2, '15-question mode exceeded the hard 2-per-category maximum.');
  }

  if (mode === 30) {
    assert.strictEqual(audit.categoryCap, 3, '30-question general category cap is not 3.');
    assert((counts.get('RULE_1') || 0) <= 1, 'Rule 1 exceeded one question in 30-question mode.');
    assert((counts.get('RULE_3') || 0) <= 1, 'Rule 3 exceeded one question in 30-question mode.');
    questions.forEach(question => {
      const category = context.getQuestionCategory(question);
      const code = context.getRuleCode(question);
      if (category === 'RULE_1') assert.strictEqual(code, '1.4', '30-question mode included a Rule 1 question other than 1.4.');
      if (category === 'RULE_3') assert.strictEqual(code, '3.4', '30-question mode included a Rule 3 question other than 3.4.');
    });
    counts.forEach((count, category) => {
      const limit = context.getThirtyQuestionCategoryLimit(category);
      assert(count <= limit, `${category} exceeded its 30-question hard cap of ${limit}.`);
    });
  }

  if (mode === 100) {
    assert(audit.hardCount >= 70, 'Extreme mode failed the 70-question difficult/long minimum.');
    counts.forEach((count, category) => {
      assert(count <= audit.categoryCap, `${category} exceeded the Extreme category cap.`);
    });
  }

  // Every generated test exercises answer-option shuffling. The full bank is also
  // exhaustively checked once per language below, which keeps long stress runs practical.
  const shuffleIndexes = [...new Set([0, Math.floor(questions.length / 2), questions.length - 1])];
  shuffleIndexes.forEach(index => assertShuffleIntegrity(context, questions[index]));
  return { keys, counts };
}

function runSequentialMode(context, mode, uniqueBank) {
  const eligiblePool = getEligiblePool(context, mode, uniqueBank);
  const eligibleKeys = new Set(eligiblePool.map(context.getQuestionKey));
  const selectionSignatures = new Set();
  const orderSignatures = new Set();
  const combinationSignatures = new Set();
  const distributionSignatures = new Set();
  const seenKeys = new Set();
  const usageCounts = new Map([...eligibleKeys].map(key => [key, 0]));
  const categoryAppearances = new Map();
  const categoryQuestionCounts = new Map();
  const categoryCountsSeen = new Map();
  const sarCounts = new Set();
  const rule1Counts = new Set();
  const rule3Counts = new Set();
  let previousKeys = null;
  let previousSelectionSignature = null;
  let previousOrderSignature = null;
  let previousDistributionSignature = null;
  let overlapTotal = 0;
  let maxOverlap = 0;
  let identicalSelectionConsecutive = 0;
  let identicalOrderConsecutive = 0;
  let identicalDistributionConsecutive = 0;
  let hardTotal = 0;
  let hardMin = Infinity;
  let hardMax = -Infinity;
  let scenarioTotal = 0;
  let scenarioMin = Infinity;
  let scenarioMax = -Infinity;
  let multiTotal = 0;
  let multiMin = Infinity;
  let multiMax = -Infinity;
  let categoryMin = Infinity;
  let categoryMax = -Infinity;

  const modeLoopStarted = Date.now();
  for (let attempt = 0; attempt < SEQUENTIAL_ATTEMPTS; attempt += 1) {
    const audit = buildMode(context, mode);
    if (process.env.RANDOMIZATION_PROGRESS && (attempt + 1) % 10 === 0) {
      console.error(`  mode ${mode}: ${attempt + 1}/${SEQUENTIAL_ATTEMPTS} in ${((Date.now() - modeLoopStarted) / 1000).toFixed(1)}s`);
    }
    const verified = verifyModeConstraints(context, mode, audit, eligiblePool);
    const keys = verified.keys;
    const counts = verified.counts;
    const keySet = new Set(keys);
    const selectionSig = selectionSignature(context, audit.questions);
    const orderSig = orderSignature(context, audit.questions);
    const combinationSig = combinationSignature(counts);
    const distributionSig = categorySignature(counts);

    if (previousKeys) {
      const overlap = intersectCount(keySet, previousKeys);
      overlapTotal += overlap;
      maxOverlap = Math.max(maxOverlap, overlap);
      if (selectionSig === previousSelectionSignature) identicalSelectionConsecutive += 1;
      if (orderSig === previousOrderSignature) identicalOrderConsecutive += 1;
      if (distributionSig === previousDistributionSignature) identicalDistributionConsecutive += 1;
    }
    previousKeys = keySet;
    previousSelectionSignature = selectionSig;
    previousOrderSignature = orderSig;
    previousDistributionSignature = distributionSig;

    selectionSignatures.add(selectionSig);
    orderSignatures.add(orderSig);
    combinationSignatures.add(combinationSig);
    distributionSignatures.add(distributionSig);
    categoryMin = Math.min(categoryMin, counts.size);
    categoryMax = Math.max(categoryMax, counts.size);

    const hard = audit.questions.filter(question => context.isDifficultOrLong(question, audit.difficultyThreshold)).length;
    const scenario = audit.questions.filter(context.isScenarioBased).length;
    const multi = audit.questions.filter(question => Array.isArray(question.correct) && question.correct.length > 1).length;
    hardTotal += hard;
    hardMin = Math.min(hardMin, hard);
    hardMax = Math.max(hardMax, hard);
    scenarioTotal += scenario;
    scenarioMin = Math.min(scenarioMin, scenario);
    scenarioMax = Math.max(scenarioMax, scenario);
    multiTotal += multi;
    multiMin = Math.min(multiMin, multi);
    multiMax = Math.max(multiMax, multi);

    keys.forEach(key => {
      seenKeys.add(key);
      usageCounts.set(key, (usageCounts.get(key) || 0) + 1);
    });
    counts.forEach((count, category) => {
      categoryAppearances.set(category, (categoryAppearances.get(category) || 0) + 1);
      categoryQuestionCounts.set(category, (categoryQuestionCounts.get(category) || 0) + count);
      if (!categoryCountsSeen.has(category)) categoryCountsSeen.set(category, new Set());
      categoryCountsSeen.get(category).add(count);
    });

    if (mode === 30) {
      sarCounts.add(counts.get('SAR') || 0);
      rule1Counts.add(counts.get('RULE_1') || 0);
      rule3Counts.add(counts.get('RULE_3') || 0);
    }
  }

  assert.strictEqual(identicalSelectionConsecutive, 0, `${mode}-question mode repeated an identical full selection consecutively.`);
  assert.strictEqual(identicalOrderConsecutive, 0, `${mode}-question mode repeated an identical full order consecutively.`);
  assert(selectionSignatures.size >= Math.floor(SEQUENTIAL_ATTEMPTS * 0.99), `${mode}-question mode generated too few distinct selections.`);
  assert(orderSignatures.size >= Math.floor(SEQUENTIAL_ATTEMPTS * 0.99), `${mode}-question mode generated too few distinct final orders.`);
  assert(distributionSignatures.size >= Math.max(10, Math.floor(SEQUENTIAL_ATTEMPTS * 0.65)), `${mode}-question mode generated too few distinct category distributions.`);
  assert(combinationSignatures.size >= Math.min(20, Math.max(5, Math.floor(SEQUENTIAL_ATTEMPTS * 0.08))), `${mode}-question mode generated too few distinct category combinations.`);
  assert(identicalDistributionConsecutive <= Math.ceil(SEQUENTIAL_ATTEMPTS * 0.03), `${mode}-question mode repeats the same category distribution consecutively too often.`);
  assert(categoryMax > categoryMin, `${mode}-question mode never varied the number of represented categories.`);
  assert(hardMax > hardMin, `${mode}-question mode has a fixed difficult-question count instead of a randomized bias.`);
  assert(scenarioMax > scenarioMin, `${mode}-question scenario mix did not vary.`);
  assert(multiMax > multiMin, `${mode}-question single/multiple-answer mix did not vary.`);

  const averageOverlap = overlapTotal / Math.max(1, SEQUENTIAL_ATTEMPTS - 1);
  if (mode === 15) {
    assert(averageOverlap <= 1.5, '15-question consecutive overlap is too high.');
    assert(maxOverlap <= 5, '15-question mode had an excessive consecutive overlap spike.');
    assert(hardMin >= 6, '15-question mode produced too few difficult/long questions.');
    assert((hardTotal / SEQUENTIAL_ATTEMPTS) >= 9, '15-question mode is not difficult enough on average.');
  } else if (mode === 30) {
    assert(averageOverlap <= 2.5, '30-question consecutive overlap is too high.');
    assert(maxOverlap <= 8, '30-question mode had an excessive consecutive overlap spike.');
    assert(hardMin >= 18, '30-question mode produced too few difficult/long questions.');
    assert((hardTotal / SEQUENTIAL_ATTEMPTS) >= 21, '30-question mode is not difficult enough on average.');
    if (SEQUENTIAL_ATTEMPTS >= 80) {
      assert(sarCounts.has(0) && [...sarCounts].some(count => count > 0), 'SAR must be optional but reachable in 30-question mode.');
      assert(rule1Counts.has(0) && rule1Counts.has(1), 'Rule 1.4 must be optional but reachable in 30-question mode.');
      assert(rule3Counts.has(0) && rule3Counts.has(1), 'Rule 3.4 must be optional but reachable in 30-question mode.');
    }
    assert(Math.max(...sarCounts) <= 3, 'SAR exceeded the 30-question category cap.');
    assert(Math.max(...rule1Counts) <= 1, 'Rule 1 exceeded its 30-question cap.');
    assert(Math.max(...rule3Counts) <= 1, 'Rule 3 exceeded its 30-question cap.');
    if (SEQUENTIAL_ATTEMPTS >= 100) {
      for (let rule = 1; rule <= 18; rule += 1) {
        const appearances = categoryAppearances.get(`RULE_${rule}`) || 0;
        assert(appearances < SEQUENTIAL_ATTEMPTS, `Rule ${rule} still behaves as permanently mandatory in 30-question mode.`);
      }
    }
  } else if (mode === 100) {
    assert(averageOverlap <= 15, '100-question consecutive overlap is too high.');
    assert(maxOverlap <= 30, '100-question mode had an excessive consecutive overlap spike.');
    assert(hardMin >= 70, 'Extreme mode weakened its difficult-question minimum.');
    assert((hardTotal / SEQUENTIAL_ATTEMPTS) >= 76, 'Extreme mode is not difficult enough on average.');
  }

  if (mode === 15 && SEQUENTIAL_ATTEMPTS >= 100) {
    categoryAppearances.forEach((appearances, category) => {
      assert(appearances < SEQUENTIAL_ATTEMPTS, `${category} still behaves as permanently mandatory in 15-question mode.`);
    });
  }

  const coverage = seenKeys.size / eligibleKeys.size;
  if (SEQUENTIAL_ATTEMPTS >= 100) {
    const minimumCoverage = mode === 100
      ? 0.99
      : SEQUENTIAL_ATTEMPTS >= 200
        ? 0.95
        : mode === 30 ? 0.9 : 0.75;
    assert(coverage >= minimumCoverage, `${mode}-question mode exercised too little of its eligible question pool.`);
  }

  const usedFrequencies = [...usageCounts.values()];
  const frequencyMean = usedFrequencies.reduce((sum, count) => sum + count, 0) / Math.max(1, usedFrequencies.length);
  const frequencyVariance = usedFrequencies.reduce((sum, count) => sum + Math.pow(count - frequencyMean, 2), 0) / Math.max(1, usedFrequencies.length);
  const frequencyStdDev = Math.sqrt(frequencyVariance);

  return {
    mode,
    attempts: SEQUENTIAL_ATTEMPTS,
    distinctSelections: selectionSignatures.size,
    distinctOrders: orderSignatures.size,
    distinctRuleCombinations: combinationSignatures.size,
    distinctDistributions: distributionSignatures.size,
    categoryCountRange: [categoryMin, categoryMax],
    averageConsecutiveOverlap: Number(averageOverlap.toFixed(2)),
    maximumConsecutiveOverlap: maxOverlap,
    consecutiveDistributionRepeats: identicalDistributionConsecutive,
    eligiblePool: eligibleKeys.size,
    coverageCount: seenKeys.size,
    coveragePercent: Number((coverage * 100).toFixed(2)),
    averageHard: Number((hardTotal / SEQUENTIAL_ATTEMPTS).toFixed(2)),
    hardRange: [hardMin, hardMax],
    averageScenario: Number((scenarioTotal / SEQUENTIAL_ATTEMPTS).toFixed(2)),
    scenarioRange: [scenarioMin, scenarioMax],
    averageMultipleAnswer: Number((multiTotal / SEQUENTIAL_ATTEMPTS).toFixed(2)),
    multipleAnswerRange: [multiMin, multiMax],
    questionUsage: {
      min: Math.min(...usedFrequencies),
      max: Math.max(...usedFrequencies),
      mean: Number(frequencyMean.toFixed(2)),
      standardDeviation: Number(frequencyStdDev.toFixed(2))
    },
    sarCounts: mode === 30 ? [...sarCounts].sort((a, b) => a - b) : undefined,
    rule1Counts: mode === 30 ? [...rule1Counts].sort((a, b) => a - b) : undefined,
    rule3Counts: mode === 30 ? [...rule3Counts].sort((a, b) => a - b) : undefined
  };
}

function testThirtyCapFailure(context, bank) {
  context.__LIMITED_BANK__ = bank;
  evaluate(context, `questionBank = __LIMITED_BANK__.filter(question => {
    const rule = getRuleNumber(question);
    return rule !== null && rule >= 1 && rule <= 9;
  })`);
  assert(evaluate(context, 'getUniqueQuestionPool(questionBank).length') >= 30, 'The hard-cap failure fixture must contain at least 30 raw unique questions.');
  assert.throws(
    () => context.buildThirtyQuestionSet(),
    /hard category limits|cannot|unable|provide/i,
    '30-question generation relaxed a hard category cap instead of failing clearly.'
  );
  setQuestionBank(context, bank);
}

function testUltramarathon(context, uniqueBank) {
  const expectedKeys = uniqueBank.map(context.getQuestionKey).sort();
  const orders = new Set();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const selected = context.selectQuestionsForTest(uniqueBank.length, evaluate(context, 'ULTRAMARATHON_MODE'));
    assert.strictEqual(selected.length, uniqueBank.length, 'Ultramarathon did not select the complete unique bank.');
    assert.deepStrictEqual(selected.map(context.getQuestionKey).sort(), expectedKeys, 'Ultramarathon omitted or added questions.');
    orders.add(orderSignature(context, selected));
  }
  assert(orders.size > 1, 'Ultramarathon final order did not vary.');
}

function testScoring(context) {
  const single = { text: '8.1 single', options: ['A', 'B'], correct: [1] };
  const multiple = { text: '8.2 multiple', options: ['A', 'B', 'C', 'D'], correct: [0, 3] };
  assert.deepStrictEqual(JSON.parse(JSON.stringify(context.scoreQuestion(single, [1]))), { correct: true, maxPoints: 5, earnedPoints: 5, percentage: 100 });
  assert.strictEqual(context.scoreQuestion(single, [0]).earnedPoints, 0, 'Wrong single answer must earn 0 points.');
  assert.strictEqual(context.scoreQuestion(single, []).earnedPoints, 0, 'Unanswered single answer must earn 0 points.');
  assert.strictEqual(context.scoreQuestion(multiple, [0, 3]).earnedPoints, 5, 'Exact multiple-answer set must earn 5 points.');
  assert.strictEqual(context.scoreQuestion(multiple, [0]).earnedPoints, 0, 'Missing a correct multiple-answer option must earn 0 points.');
  assert.strictEqual(context.scoreQuestion(multiple, [0, 1, 3]).earnedPoints, 0, 'An extra incorrect multiple-answer option must earn 0 points.');
  assert.strictEqual(context.scoreQuestion(multiple, []).earnedPoints, 0, 'Unanswered multiple-answer question must earn 0 points.');

  const extraEvaluation = context.getQuestionEvaluation(multiple, [0, 1, 3]);
  assert.deepStrictEqual(Array.from(extraEvaluation.selectedCorrect), [0, 3]);
  assert.deepStrictEqual(Array.from(extraEvaluation.selectedWrong), [1]);
  assert.deepStrictEqual(Array.from(extraEvaluation.missingCorrect), []);
  assert.strictEqual(extraEvaluation.scoreReasonKey, 'noCreditExtra');
  const missingEvaluation = context.getQuestionEvaluation(multiple, [0]);
  assert.deepStrictEqual(Array.from(missingEvaluation.missingCorrect), [3]);
  assert.strictEqual(missingEvaluation.scoreReasonKey, 'noCreditMissing');

  const totals = [
    [15, 12, 75, 60, 80, true],
    [30, 24, 150, 120, 80, true],
    [100, 80, 500, 400, 80, true]
  ];
  totals.forEach(([total, correctCount, maxPoints, earnedPoints, percent, passed]) => {
    context.__SCORING_QUESTIONS__ = Array.from({ length: total }, (_, index) => ({ text: `8.${index} test`, options: ['A', 'B'], correct: [0] }));
    context.__SCORING_ANSWERS__ = Array.from({ length: total }, (_, index) => index < correctCount ? [0] : [1]);
    const result = JSON.parse(evaluate(context, 'currentQuestions = __SCORING_QUESTIONS__; answers = __SCORING_ANSWERS__; JSON.stringify(calculateResult(false))'));
    assert.strictEqual(result.maxPoints, maxPoints, `${total} questions must have maximum ${maxPoints} points.`);
    assert.strictEqual(result.earnedPoints, earnedPoints, 'Earned-points calculation is wrong.');
    assert.strictEqual(result.percent, percent, 'Percentage calculation is wrong.');
    assert.strictEqual(result.questionPercent, percent, 'Question percentage must match point percentage with equal 5-point weighting.');
    assert.strictEqual(result.passed, passed, 'Pass/fail did not use calculated percentage correctly.');
    assert(result.items.every(item => item.maxPoints === 5 && [0, 5].includes(item.earnedPoints)), 'Per-question scoring is not fixed at all-or-nothing 5 points.');
  });

  context.__SCORING_QUESTIONS__ = Array.from({ length: 15 }, (_, index) => ({ text: `9.${index} fail`, options: ['A', 'B'], correct: [0] }));
  context.__SCORING_ANSWERS__ = Array.from({ length: 15 }, (_, index) => index < 11 ? [0] : [1]);
  const failing = JSON.parse(evaluate(context, 'currentQuestions = __SCORING_QUESTIONS__; answers = __SCORING_ANSWERS__; JSON.stringify(calculateResult(false))'));
  assert.strictEqual(failing.maxPoints, 75);
  assert.strictEqual(failing.earnedPoints, 55);
  assert.strictEqual(failing.percent, 73.33);
  assert.strictEqual(failing.passed, false, 'Existing PASS_PERCENT threshold was not applied to the new percentage.');
}

function testStorageIsolation(bank, seed = 0xabcddcba) {
  const context = makeContext(seed);
  setQuestionBank(context, bank);
  context.__storageReads.length = 0;
  context.__storageWrites.length = 0;
  context.buildCategoryFirstQuestionSet(15);
  context.buildThirtyQuestionSet();
  context.buildExtremeQuestionSet();
  assert.deepStrictEqual(context.__storageReads, [], 'Randomization read localStorage after application initialization.');
  assert.deepStrictEqual(context.__storageWrites, [], 'Randomization wrote persistent browser storage.');
  const populatedHistorySize = evaluate(context, 'randomizationModeHistory.size');
  assert(populatedHistorySize >= 3, 'In-memory anti-repeat history was not populated.');
  const reloaded = makeContext(seed ^ 0xffffffff);
  setQuestionBank(reloaded, bank);
  assert.strictEqual(evaluate(reloaded, 'randomizationModeHistory.size'), 0, 'A fresh page context did not reset anti-repeat history.');
}

function runBankTests(filename, seed) {
  const bank = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const originalBankSnapshot = JSON.stringify(bank);
  const context = makeContext(seed);
  setQuestionBank(context, bank);
  const uniqueBank = getUniqueBank(context);
  uniqueBank.forEach(question => assertShuffleIntegrity(context, question));

  const cap2Capacity = [...categoryCounts(context, uniqueBank).values()].reduce((sum, count) => sum + Math.min(2, count), 0);
  assert(cap2Capacity >= 15, `${filename} cannot support the configured 15-question 2-per-category cap.`);

  const modeStats = [];
  for (const mode of [15, 30, 100]) {
    const started = Date.now();
    modeStats.push(runSequentialMode(context, mode, uniqueBank));
    if (process.env.RANDOMIZATION_PROGRESS) {
      console.error(`${filename} ${mode}-question stress completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  }
  testThirtyCapFailure(context, bank);
  if (process.env.RANDOMIZATION_PROGRESS) console.error(`${filename} cap-failure check done`);
  testUltramarathon(context, uniqueBank);
  if (process.env.RANDOMIZATION_PROGRESS) console.error(`${filename} Ultramarathon check done`);
  testScoring(context);
  if (process.env.RANDOMIZATION_PROGRESS) console.error(`${filename} scoring check done`);
  testStorageIsolation(bank, seed ^ 0x55aa55aa);
  if (process.env.RANDOMIZATION_PROGRESS) console.error(`${filename} storage-isolation check done`);
  assert(context.__seededCrypto.getCallCount() > 0, 'Seeded crypto source was never used.');
  assert.strictEqual(JSON.stringify(bank), originalBankSnapshot, `${filename} question-bank objects were mutated.`);

  return { filename, uniqueQuestions: uniqueBank.length, attemptsPerMode: SEQUENTIAL_ATTEMPTS, modes: modeStats };
}

function runAllBanks() {
  assert.strictEqual(Number(evaluate(makeContext(), 'PASS_PERCENT')), 75, 'PASS_PERCENT changed unexpectedly.');
  assert.strictEqual(Number(evaluate(makeContext(), 'POINTS_PER_QUESTION')), 5, 'Every question must be worth exactly 5 points.');
  assert(!appScript.includes('Math.random'), 'Math.random must not be used anywhere in quiz randomization.');
  assert(!appScript.includes('.sort(() => Math.random() - 0.5)'), 'Prohibited random sort remains in the app.');
  assert(appScript.includes('cryptoObject.getRandomValues'), 'Secure RNG does not use crypto.getRandomValues.');
  assert(appScript.includes('RANDOMIZATION_HISTORY_DEPTH = 16'), 'Deep in-memory anti-repeat history is missing.');
  assert(appScript.includes('questionUsageCounts: new Map()'), 'Per-mode in-memory question usage balancing is missing.');
  assert(appScript.includes('randomizationModeHistory'), 'Reusable per-mode recent-history state is missing.');
  assert(appScript.includes('recencyDepths') && appScript.includes('lastSeenGeneration'), 'Recent-question anti-repeat selection is missing.');
  assert(appScript.includes('getCandidateDiversity'), 'Candidate diversity scoring is missing.');
  assert(appScript.includes("THIRTY_RULE_ONLY_CODES = new Map([[1, '1.4'], [3, '3.4']])"), 'Rule 1.4/3.4 special configuration is missing.');
  assert(!appScript.includes('sessionStorage'), 'sessionStorage must not influence randomization.');
  assert(!appScript.includes('indexedDB'), 'IndexedDB must not influence randomization.');
  assert(!appScript.includes('document.cookie'), 'Cookies must not influence randomization.');
  const randomizationRegion = appScript.slice(appScript.indexOf("const ULTRAMARATHON_MODE"), appScript.indexOf('function shuffleQuestionAnswers'));
  assert(!randomizationRegion.includes('localStorage'), 'Language localStorage leaked into randomization logic.');
  assert(!randomizationRegion.includes('participantName'), 'Participant identity leaked into randomization logic.');
  assert(appScript.includes('maxPoints: POINTS_PER_QUESTION'), 'Fixed 5-point question scoring is missing.');
  assert(appScript.includes("scoreReasonKey = 'noCreditExtra'"), 'Detailed extra-wrong-answer zero-credit reason is missing.');
  assert(appScript.includes("scoreReasonKey = 'noCreditMissing'"), 'Detailed missing-answer zero-credit reason is missing.');

  const results = [
    runBankTests('questions-en.json', 0x13579bdf),
    runBankTests('questions-lt.json', 0x2468ace0)
  ];
  console.log(JSON.stringify(results, null, 2));
  console.log('All randomization and scoring tests passed.');
  return results;
}

if (require.main === module) runAllBanks();

module.exports = { runAllBanks, SEQUENTIAL_ATTEMPTS };
