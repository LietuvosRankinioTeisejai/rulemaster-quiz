process.env.RANDOMIZATION_ATTEMPTS = process.env.RANDOMIZATION_ATTEMPTS || '600';
const { runAllBanks, SEQUENTIAL_ATTEMPTS } = require('./randomization.test');
console.log(`Running heavy sequential randomization stress suite with ${SEQUENTIAL_ATTEMPTS} generations per mode and language.`);
runAllBanks();
