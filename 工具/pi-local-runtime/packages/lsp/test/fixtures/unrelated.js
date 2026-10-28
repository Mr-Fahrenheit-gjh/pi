// An unrelated extension must not inherit this package's helper fallback.
import { create_child_process_env } from '@spences10/pi-child-env';
export default () => { create_child_process_env(); };
