System managed data directory

- each container gets a mount location in this directory to store their specific data
- typically the $HOME directory of the container but can be whatever the container needs
- memory holds the generated memory configuration from the stack.yaml that is used by the memory container
- stash is the assistants global akm-cli stash directory