.PHONY: install lint mock mock-iot mock-vision mock-all test-mock test-local test-html test-ci clean

install:
	npm install

lint:
	npm run lint:contracts

mock: mock-iot

mock-iot:
	npm run mock:iot

mock-vision:
	npm run mock:vision

mock-all:
	npm run mock:all

test-mock:
	npm run test:mock

test-local:
	npm run test:local

test-html:
	npm run test:html

test-ci:
	npm run test:ci

clean:
	rm -f reports/*.xml reports/*.html reports/*.json prism*.log
