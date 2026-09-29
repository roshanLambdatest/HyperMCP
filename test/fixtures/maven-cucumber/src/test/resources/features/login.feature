@smoke
Feature: Login
  Scenario: good login
    Given x
  @regression
  Scenario Outline: bad login
    Given <u>
    Examples:
      | u |
      | a |
