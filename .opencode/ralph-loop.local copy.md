---
title: loop
active: true
session_id: null
iteration: 1
max_iterations: 0
completion_promise: null
started_at: "2026-02-25T07:11:55Z"
---

continue consolidating/pruning environment variables, improving brittle tests and test harness setup, and complex configuration, improving test quality, building and running the stack, testing the setup wizard using chrome devtools, writing playwright tests based on your exploration, recording all issues, fixing them, and restarting the process. do this until the setup wizard can be ran in a clean test environment successfully three times in a row all the way through the final step is done. once the setup wizard is fully functional and we have valid tests to prove it is working with a completed wizard screenshot, save the screenshots to prove it is working. We do not care if all automated tests pass, it is a failure if you cannot manually complete the setup wizard using dev tools. the final test should include verifing files are created and valid based on the wizard setup. things like stack spec, caddy json, .env files should all be verified after the final step is compelte on the wizard. tests should fail if the services do not respond in time and the "services took too long to start" message is displayed or any services are labeled with a not ready status. the system must be in working order for the test to be considered successful.

 change whatever you need to to make this work smoothly, repeatedly, and can prove it consistently and dependably with automated tests.

 Once the screenshots are saved reply with only <promise>DONE</promise>  
