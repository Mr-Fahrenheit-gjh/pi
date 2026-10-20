/** Browser-local time: morning before noon, afternoon before 18:00. */
export function newSessionGreeting(date = new Date()): string {
  const hour = date.getHours();
  const period = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
  return `${period}, Mr.Fahrenheit`;
}
