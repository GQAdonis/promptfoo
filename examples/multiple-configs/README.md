# multiple-configs (Multiple Configs)

You can run this example with:

```bash
npx promptfoo@latest init --example multiple-configs
```

To get started, set your OPENAI_API_KEY environment variable.

Next, edit promptfooconfig.yaml.

Then run:

```
promptfoo eval -c configs/*
```

or

```
promptfoo eval -c configs/config1.yaml configs/config2.yaml
```

Afterwards, you can view the results by running `promptfoo view`
