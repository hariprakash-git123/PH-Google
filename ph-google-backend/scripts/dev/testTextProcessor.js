const { processHtml, calculateFrequencies } = require('../../utils/textProcessor');

const fakeHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>React JS Tutorial</title>
  <style> body { color: red; } </style>
</head>
<body>
  <script> console.log("Ignore me!"); </script>
  
  <h1>Hello, World! Welcome to React.</h1>
  <p>React is a JavaScript library for building user interfaces. It is declarative, efficient, and very flexible.</p>
  <p>Learn React today and build awesome apps!</p>
</body>
</html>
`;

console.log('--- RAW HTML ---');
console.log(fakeHtml);

console.log('\n--- 1. PROCESSING HTML ---');
const tokens = processHtml(fakeHtml);
console.log('Tokens extracted:', tokens);

console.log('\n--- 2. CALCULATING FREQUENCIES ---');
const frequencies = calculateFrequencies(tokens);
console.log('Word Frequencies:', frequencies);

console.log('\nTest Completed Successfully! ✅');
