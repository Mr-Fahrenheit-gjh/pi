/** Pick once per welcome visit; time-specific copy follows the browser's local clock. */
export function newSessionGreeting(
  date = new Date(),
  previous = "",
  random = Math.random,
): string {
  const hour = date.getHours();
  const period = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
  const greetings = [
    period,
    "Hello",
    "Hey there",
    "Hi there",
    "Welcome back",
    "Good to see you",
    "Nice to see you",
    "Happy to see you",
  ].map((text) => `${text}, Mr.Fahrenheit`);
  const choices = greetings.filter((text) => text !== previous);
  return choices[Math.floor(random() * choices.length)];
}
