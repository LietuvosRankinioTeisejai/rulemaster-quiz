const fs = require('fs');
const assert = require('assert');

const html = fs.readFileSync('index.html', 'utf8');
const scriptMatches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
const appScript = scriptMatches[scriptMatches.length - 1][1];

assert(html.includes('id="progress-track"'), 'Answered progress bar is missing.');
assert(html.includes('id="review-button"'), 'Mark-for-review control is missing.');
assert(html.includes('id="question-navigator-dialog"'), 'Question navigator dialog is missing.');
assert(html.includes('id="finish-dialog"'), 'Custom finish confirmation dialog is missing.');
assert(html.includes('id="compact-navigator"'), 'Compact long-test navigator is missing.');
assert(html.includes('id="ultra-test-title"'), 'Ultramarathon test card is missing.');
assert(html.includes('onclick="startUltramarathon()"'), 'Ultramarathon start action is missing.');
assert(html.includes('id="ultra-achievement"'), 'Ultramarathon finisher banner is missing.');
assert(!/<article class="test-card"[^>]*onclick=/i.test(html), 'Test cards should not use duplicate click handlers.');
assert(appScript.includes("input.type = 'checkbox'"), 'Every question should allow selecting multiple answer options.');
assert(!appScript.includes("input.type = isMultipleAnswer ? 'checkbox' : 'radio'"), 'Single-answer questions still force radio-button selection.');
assert(appScript.includes("document.getElementById('answer-instruction').textContent = t('answerInstruction')"), 'The quiz still reveals whether a question has one or multiple correct answers.');
assert(appScript.includes('const position = answer.indexOf(optionIndex);'), 'Answer selection does not toggle independent options.');
assert(appScript.includes('reviewedQuestions[currentIndex]'), 'Review state is not stored per question.');
assert(appScript.includes("quizScreen.classList.toggle('large-test', numQuestions >= 100)"), 'The 100-question compact navigator mode is not enabled.');
assert(appScript.includes("if (mode === ULTRAMARATHON_MODE) return shuffleArray(bank);"), 'Ultramarathon does not select and shuffle the complete unique bank.');
assert(appScript.includes("t('ultraTestMetaDynamic', { count, minutes: count })"), 'Ultramarathon does not display the live question count.');
assert(appScript.includes('const isUltramarathonFinisher'), 'Ultramarathon finisher recognition is missing.');
assert(appScript.includes('if (isLargeTest) {'), 'Large-test navigator rendering is not optimized.');
assert(appScript.includes("document.addEventListener('keydown', handleQuizKeyboard)"), 'Keyboard navigation is not registered.');
assert(!appScript.includes("if (confirm(t('confirmFinish')))"), 'Legacy browser finish confirmation remains.');

console.log('All interface checks passed.');
